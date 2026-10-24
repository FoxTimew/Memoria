import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { YjsCache, legacyDatabase, retireLegacyDrafts } from './yjs-cache.ts';
import { signOutAndClear } from './local-sign-out.ts';

function fixture() {
  const factory = new IDBFactory();
  return {
    factory,
    store: new YjsCache(
      () => factory,
      () => '',
    ),
  };
}
function update(text: string) {
  const doc = new Y.Doc();
  doc.getText('text').insert(0, text);
  const bytes = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  return bytes;
}
function text(updates: Uint8Array[]) {
  const doc = new Y.Doc();
  for (const bytes of updates) Y.applyUpdate(doc, bytes);
  const value = doc.getText('text').toString();
  doc.destroy();
  return value;
}

describe('Yjs cache transaction and identity boundaries', () => {
  it('survives reopening, scopes user/workspace/page/generation and never mixes old generations', async () => {
    const { factory, store } = fixture(),
      ticket = await store.ticket('alice', 'session');
    const opened = await store.open(ticket, 'workspace', 'page', 'generation');
    await store.append(ticket, opened.page, update('Hors ligne'), 'receipt-a');
    const reopened = await new YjsCache(
      () => factory,
      () => '',
    ).open(ticket, 'workspace', 'page', 'generation');
    expect(text(reopened.updates)).toBe('Hors ligne');
    expect(reopened.page.pending).toEqual(['receipt-a']);
    const next = await store.open(ticket, 'workspace', 'page', 'next');
    expect(next.updates).toEqual([]);
    expect(next.older.map((p) => p.generation)).toEqual(['generation']);
    expect((await store.open(ticket, 'other', 'page', 'generation')).updates).toEqual([]);
    expect((await store.open(ticket, 'workspace', 'other', 'generation')).updates).toEqual([]);
    const bob = await store.ticket('bob', 'session');
    expect((await store.open(bob, 'workspace', 'page', 'generation')).updates).toEqual([]);
  });
  it('merges two tabs without overwriting their work; a receipt only removes known pending tokens', async () => {
    const { store } = fixture(),
      ticket = await store.ticket('alice', 'session');
    const a = await store.open(ticket, 'workspace', 'page', 'generation'),
      b = await store.open(ticket, 'workspace', 'page', 'generation');
    await Promise.all([
      store.append(ticket, a.page, update('A'), 'a'),
      store.append(ticket, b.page, update('B'), 'b'),
    ]);
    await store.acknowledge(ticket, a.page, ['a']);
    const saved = await store.open(ticket, 'workspace', 'page', 'generation');
    expect(text(saved.updates).split('').sort().join('')).toBe('AB');
    expect(saved.page.pending).toEqual(['b']);
  });
  it('compacts updates without losing delete-only updates or Yjs identities', async () => {
    const { store } = fixture(),
      ticket = await store.ticket('alice', 'session');
    const page = (await store.open(ticket, 'workspace', 'page', 'generation')).page;
    const doc = new Y.Doc();
    let latest!: Uint8Array;
    doc.on('update', (bytes: Uint8Array) => {
      latest = bytes;
    });
    for (let i = 0; i < 70; i++) {
      doc.getText('text').insert(i, 'x');
      await store.append(ticket, page, latest, String(i));
    }
    doc.getText('text').delete(0, 70);
    await store.append(ticket, page, latest, 'deletion');
    const reopened = await store.open(ticket, 'workspace', 'page', 'generation');
    expect(reopened.updates.length).toBeLessThan(64);
    expect(text(reopened.updates)).toBe('');
    const restored = new Y.Doc();
    for (const u of reopened.updates) Y.applyUpdate(restored, u);
    expect(Y.encodeStateVector(restored)).toEqual(Y.encodeStateVector(doc));
    expect(reopened.page.pending).toContain('deletion');
    doc.destroy();
    restored.destroy();
  });
  it('erases all content for one user and fences sleeping tabs, queued writes and delayed HTTP tickets', async () => {
    const { store } = fixture(),
      ticket = await store.ticket('alice', 'session'),
      old = await store.ticket('alice', 'old');
    const a = await store.open(ticket, 'workspace', 'a', 'generation'),
      b = await store.open(old, 'workspace', 'b', 'generation');
    const bob = await store.ticket('bob', 'bob'),
      bobPage = await store.open(bob, 'workspace', 'a', 'generation');
    await store.append(bob, bobPage.page, update('Bob'), 'b');
    const pending = store.append(ticket, a.page, update('Alice'), 'a').catch(() => {});
    await store.clearUser('alice', 'session');
    await pending;
    await expect(store.append(old, b.page, update('Tardif'), 'late')).rejects.toThrow(
      'déconnectée',
    );
    await expect(store.acknowledge(ticket, a.page, ['a'])).rejects.toThrow('déconnectée');
    await expect(store.open(old, 'workspace', 'page', 'generation')).rejects.toThrow('déconnectée');
    await expect(store.ticket('alice', 'session')).rejects.toThrow('déconnectée');
    await expect(store.assertActive(ticket)).rejects.toThrow('déconnectée');
    const fresh = await store.ticket('alice', 'new-login');
    for (const page of ['a', 'b'])
      expect((await store.open(fresh, 'workspace', page, 'generation')).updates).toEqual([]);
    expect(text((await store.open(bob, 'workspace', 'a', 'generation')).updates)).toBe('Bob');
  });
  it('fences an obsolete writer after explicit discard; a new handle starts empty', async () => {
    const { store } = fixture(),
      ticket = await store.ticket('alice', 'session');
    const a = await store.open(ticket, 'workspace', 'page', 'generation');
    await store.append(ticket, a.page, update('Abandon'), 'a');
    await store.discard(ticket, a.page);
    await expect(store.append(ticket, a.page, update('Late'))).rejects.toThrow('abandonné');
    expect((await store.open(ticket, 'workspace', 'page', 'generation')).updates).toEqual([]);
  });
  it('checks the cross-tab marker inside the transaction and reports missing storage / size limit', async () => {
    const factory = new IDBFactory();
    let marker = '';
    const store = new YjsCache(
        () => factory,
        () => marker,
      ),
      ticket = await store.ticket('alice', 'session');
    const page = (await store.open(ticket, 'workspace', 'page', 'generation')).page;
    await expect(store.append(ticket, page, new Uint8Array(8 * 1024 ** 2 + 1))).rejects.toThrow(
      '8 Mio',
    );
    marker = 'signed-out';
    await expect(store.append(ticket, page, update('Late'))).rejects.toThrow('déconnectée');
    const unavailable = new YjsCache(
      () => {
        throw new Error('Storage denied');
      },
      () => '',
    );
    await expect(unavailable.ticket('alice', 'session')).rejects.toThrow('Storage denied');
    await expect(unavailable.clearUser('alice', 'session')).rejects.toThrow('Storage denied');
  });
  it('retires v1 drafts at first load and prevents an old version from recreating them', async () => {
    const factory = new IDBFactory();
    await new Promise<void>((resolve, reject) => {
      const r = factory.open(legacyDatabase, 1);
      r.onupgradeneeded = () => {
        r.result.createObjectStore('drafts');
        r.result.createObjectStore('sessions');
      };
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        const tx = r.result.transaction('drafts', 'readwrite');
        tx.objectStore('drafts').put('secret content', 'alice');
        tx.oncomplete = () => {
          r.result.close();
          resolve();
        };
      };
    });
    await retireLegacyDrafts(factory);
    await retireLegacyDrafts(factory);
    await new Promise<void>((resolve, reject) => {
      const r = factory.open(legacyDatabase, 1);
      r.onerror = () => {
        expect(r.error?.name).toBe('VersionError');
        resolve();
      };
      r.onsuccess = () => {
        r.result.close();
        reject(new Error('Legacy database reopened'));
      };
    });
    await new Promise<void>((resolve, reject) => {
      const r = factory.open(legacyDatabase);
      r.onerror = () => reject(r.error);
      r.onsuccess = () => {
        expect([...r.result.objectStoreNames]).toEqual(['retired']);
        r.result.close();
        resolve();
      };
    });
  });
  it('revokes the server session even when erasure fails, and does not announce a clean device', async () => {
    const remote = vi.fn(async () => {}),
      notify = vi.fn();
    expect(
      await signOutAndClear(
        'alice',
        'session',
        remote,
        async () => {
          throw new Error('Quota');
        },
        notify,
      ),
    ).toEqual({ cacheCleared: false, serverSignedOut: true });
    expect(remote).toHaveBeenCalledOnce();
    expect(notify).toHaveBeenCalledOnce();
    expect(
      await signOutAndClear(
        'alice',
        'session',
        async () => {
          throw new Error('Network');
        },
        async () => {},
        notify,
      ),
    ).toEqual({ cacheCleared: true, serverSignedOut: false });
  });
});
