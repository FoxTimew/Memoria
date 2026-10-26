import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { YjsCache, legacyDatabase, retireLegacyDrafts } from './yjs-cache.ts';
import { signOutAndClear } from './local-sign-out.ts';
import type { CacheTicket } from './yjs-cache.ts';

function pageSnapshot(accessVersion = 1, changes: Record<string, number | null> = {}) {
  return {
    accessVersion,
    pages: ['page', 'p', 'one', 'two', 'three', 'other', 'a', 'b']
      .filter((page) => changes[page] !== null)
      .map((page) => ({ page, version: changes[page] ?? 1, level: 'edit' as const })),
  };
}
async function pagesAllowed(store: YjsCache, ticket: CacheTicket) {
  let current = ticket;
  for (const [workspace, version] of Object.entries(ticket.accessVersions))
    current = await store.applyPageAccess(current, workspace, pageSnapshot(version));
  return current;
}

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
async function allowedTicket(store: YjsCache, user: string, session: string) {
  const ticket = await store.ticket(user, session);
  return pagesAllowed(
    store,
    await store.applyPolicy(ticket, {
      user,
      session,
      sharedComputer: false,
      workspaces: ['workspace', 'other'].map((workspace) => ({
        workspace,
        allowed: true,
        version: 1,
      })),
    }),
  );
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
  it('upgrades v3 without erasing unchanged pages or logout tombstones; changed pages are retired', async () => {
    const { factory, store } = fixture();
    await new Promise<void>((resolve, reject) => {
      const r = factory.open('memoria-yjs-cache-v1', 3);
      r.onerror = () => reject(r.error);
      r.onupgradeneeded = () => {
        const db = r.result;
        db.createObjectStore('users', { keyPath: 'user' });
        db.createObjectStore('sessions', { keyPath: ['user', 'session'] }).createIndex(
          'user',
          'user',
        );
        db.createObjectStore('policies', { keyPath: ['user', 'workspace'] }).createIndex(
          'user',
          'user',
        );
        db.createObjectStore('documents', { keyPath: 'key' }).createIndex('user', 'user');
        const updates = db.createObjectStore('updates', { keyPath: 'id', autoIncrement: true });
        updates.createIndex('user', 'user');
        updates.createIndex('key', 'key');
      };
      r.onsuccess = () => {
        const db = r.result,
          tx = db.transaction(
            ['users', 'sessions', 'policies', 'documents', 'updates'],
            'readwrite',
          );
        tx.objectStore('users').put({ user: 'alice', epoch: 0 });
        tx.objectStore('sessions').put({ user: 'alice', session: 'logged-out', revoked: true });
        tx.objectStore('policies').put({
          user: 'alice',
          workspace: 'workspace',
          version: 1,
          accessVersion: 1,
          epoch: 0,
          allowed: true,
        });
        for (const page of ['one', 'two']) {
          const key = JSON.stringify(['alice', 'workspace', page, 'g']);
          tx.objectStore('documents').put({
            key,
            user: 'alice',
            workspace: 'workspace',
            page,
            generation: 'g',
            epoch: 0,
            count: 1,
            bytes: 50,
            pending: ['unsent'],
          });
          tx.objectStore('updates').add({ key, user: 'alice', data: update('v3 pending') });
        }
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onabort = () => reject(tx.error);
      };
    });
    await expect(store.ticket('alice', 'logged-out')).rejects.toThrow('déconnectée');
    const policy = await store.applyPolicy(await store.ticket('alice', 'new'), {
      user: 'alice',
      session: 'new',
      sharedComputer: false,
      workspaces: [{ workspace: 'workspace', version: 1, accessVersion: 2, allowed: true }],
    });
    const fresh = await store.applyPageAccess(policy, 'workspace', pageSnapshot(2, { one: 2 }));
    expect((await store.open(fresh, 'workspace', 'one', 'g')).updates).toEqual([]);
    expect(text((await store.open(fresh, 'workspace', 'two', 'g')).updates)).toBe('v3 pending');
    expect((await store.open(fresh, 'workspace', 'two', 'g')).page.pending).toEqual(['unsent']);
  });
  it('a late revocation from an old replica cannot erase a new authorized replica', async () => {
    const { store } = fixture();
    const old = await allowedTicket(store, 'alice', 'a');
    const policy = await store.applyPolicy(await store.ticket('alice', 'a'), {
      user: 'alice',
      session: 'a',
      sharedComputer: false,
      workspaces: [{ workspace: 'workspace', version: 1, accessVersion: 2, allowed: true }],
    });
    const fresh = await store.applyPageAccess(policy, 'workspace', pageSnapshot(2, { page: 2 }));
    const page = (await store.open(fresh, 'workspace', 'page', 'g')).page;
    await store.append(fresh, page, update('new authorized work'));
    await store.revokePage(old, 'workspace', 'page');
    expect(text((await store.open(fresh, 'workspace', 'page', 'g')).updates)).toBe(
      'new authorized work',
    );
    await expect(store.open(old, 'workspace', 'page', 'g')).rejects.toThrow('accès ont changé');
  });
  it('a changed page purges only itself, fences frozen writers and preserves other pages/workspaces/users', async () => {
    const { store } = fixture();
    const old = await allowedTicket(store, 'alice', 'a'),
      bob = await allowedTicket(store, 'bob', 'b');
    const a = (await store.open(old, 'workspace', 'one', 'g')).page,
      b = (await store.open(old, 'workspace', 'two', 'g')).page;
    const other = (await store.open(old, 'other', 'three', 'g')).page,
      bobs = (await store.open(bob, 'workspace', 'one', 'g')).page;
    for (const [ticket, page] of [
      [old, a],
      [old, b],
      [old, other],
      [bob, bobs],
    ] as const)
      await store.append(ticket, page, update('private'), 'pending');
    const inFlight = old;
    const snapshot = {
      user: 'alice',
      session: 'a',
      sharedComputer: false,
      workspaces: [
        { workspace: 'workspace', version: 1, accessVersion: 2, allowed: true },
        { workspace: 'other', version: 1, accessVersion: 1, allowed: true },
      ],
    };
    const policy = await store.applyPolicy(await store.ticket('alice', 'a'), snapshot);
    const fresh = await store.applyPageAccess(policy, 'workspace', pageSnapshot(2, { one: 2 }));
    expect((await store.open(fresh, 'workspace', 'one', 'g')).updates).toEqual([]);
    expect(text((await store.open(fresh, 'workspace', 'two', 'g')).updates)).toBe('private');
    await store.append(old, b, update('still permitted'));
    expect(text((await store.open(old, 'other', 'three', 'g')).updates)).toBe('private');
    expect(text((await store.open(bob, 'workspace', 'one', 'g')).updates)).toBe('private');
    await expect(store.append(old, a, update('late'))).rejects.toThrow('accès ont changé');
    await expect(store.acknowledge(old, a, ['pending'])).rejects.toThrow('accès ont changé');
    const delayed = await store.applyPageAccess(inFlight, 'workspace', pageSnapshot(1));
    await expect(store.open(delayed, 'workspace', 'one', 'g')).rejects.toThrow('accès ont changé');
    // Regrant is a later epoch too: adopting it cannot make an existing Y.Doc's ticket valid.
    const regrantPolicy = await store.applyPolicy(await store.ticket('alice', 'a'), {
      ...snapshot,
      workspaces: [{ workspace: 'workspace', version: 1, accessVersion: 3, allowed: true }],
    });
    const regrant = await store.applyPageAccess(
      regrantPolicy,
      'workspace',
      pageSnapshot(3, { one: 3 }),
    );
    await expect(store.open(fresh, 'workspace', 'one', 'g')).rejects.toThrow('accès ont changé');
    expect((await store.open(regrant, 'workspace', 'one', 'g')).updates).toEqual([]);
  });
  it('explicit revocation tombstone rejects responses begun before purge and queued appends', async () => {
    const { store } = fixture(),
      old = await allowedTicket(store, 'alice', 'a');
    const p = (await store.open(old, 'workspace', 'one', 'g')).page;
    const inFlight = old;
    await store.revokePage(old, 'workspace', 'one');
    await expect(store.append(old, p, update('late'))).rejects.toThrow('accès ont changé');
    const stale = await store.applyPageAccess(inFlight, 'workspace', pageSnapshot(1));
    await expect(store.open(stale, 'workspace', 'one', 'g')).rejects.toThrow('accès ont changé');
  });
  it('does not resurrect a removed membership from an older in-flight policy response at the same server version', async () => {
    const { store } = fixture();
    const old = await allowedTicket(store, 'alice', 'a');
    const page = (await store.open(old, 'workspace', 'page', 'g')).page;
    await store.append(old, page, update('private'));
    const inFlight = await store.ticket('alice', 'a');
    await store.applyPolicy(await store.ticket('alice', 'a'), {
      user: 'alice',
      session: 'a',
      sharedComputer: false,
      workspaces: [],
    });
    const stale = await store.applyPolicy(inFlight, {
      user: 'alice',
      session: 'a',
      sharedComputer: false,
      workspaces: [{ workspace: 'workspace', version: 1, allowed: true }],
    });
    await expect(store.open(stale, 'workspace', 'page', 'g')).rejects.toThrow('accès ont changé');
    await expect(store.append(old, page, update('late'))).rejects.toThrow('accès ont changé');
    const fresh = await allowedTicket(store, 'alice', 'a');
    expect((await store.open(fresh, 'workspace', 'page', 'g')).updates).toEqual([]);
  });
  it('a signed-out or mismatched response cannot reauthorize cache', async () => {
    const { store } = fixture();
    const ticket = await store.ticket('alice', 'a');
    await expect(
      store.applyPolicy(ticket, {
        user: 'bob',
        session: 'b',
        sharedComputer: false,
        workspaces: [],
      }),
    ).rejects.toThrow('déconnectée');
    await store.clearUser('alice', 'a');
    await expect(
      store.applyPolicy(ticket, {
        user: 'alice',
        session: 'a',
        sharedComputer: false,
        workspaces: [{ workspace: 'workspace', version: 10, allowed: true }],
      }),
    ).rejects.toThrow('déconnectée');
    await expect(
      store.applyPolicy(ticket, {
        user: 'alice',
        session: 'a',
        sharedComputer: true,
        workspaces: [],
      }),
    ).rejects.toThrow('déconnectée');
  });
  it('retires pre-epoch cached content on upgrade and prevents old writers reopening', async () => {
    const { factory, store } = fixture();
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('memoria-yjs-cache-v1', 1);
      request.onerror = () => reject(request.error);
      request.onupgradeneeded = () => {
        const db = request.result;
        db.createObjectStore('users', { keyPath: 'user' });
        db.createObjectStore('sessions', { keyPath: ['user', 'session'] }).createIndex(
          'user',
          'user',
        );
        db.createObjectStore('documents', { keyPath: 'key' }).createIndex('user', 'user');
        const updates = db.createObjectStore('updates', { keyPath: 'id', autoIncrement: true });
        updates.createIndex('key', 'key');
        updates.createIndex('user', 'user');
      };
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction(['documents', 'updates'], 'readwrite');
        const key = JSON.stringify(['alice', 'workspace', 'page', 'g']);
        tx.objectStore('documents').put({
          key,
          user: 'alice',
          workspace: 'workspace',
          page: 'page',
          generation: 'g',
          epoch: 0,
          count: 1,
          bytes: 100,
          pending: ['old'],
        });
        tx.objectStore('updates').add({ key, user: 'alice', data: update('v1 content') });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
      };
    });
    const ticket = await allowedTicket(store, 'alice', 'a');
    expect(text((await store.open(ticket, 'workspace', 'page', 'g')).updates)).toBe('');
    await new Promise<void>((resolve, reject) => {
      const request = factory.open('memoria-yjs-cache-v1', 1);
      request.onerror = () => {
        expect(request.error?.name).toBe('VersionError');
        resolve();
      };
      request.onsuccess = () => {
        request.result.close();
        reject(new Error('Old writer reopened'));
      };
    });
  });
  it('never reads content without a fresh policy and rejects a response arriving after a ban', async () => {
    const { store } = fixture();
    const bare = await store.ticket('alice', 'a');
    await expect(store.open(bare, 'workspace', 'page', 'g')).rejects.toThrow('désactivée');
    const old = await allowedTicket(store, 'alice', 'a');
    const page = (await store.open(old, 'workspace', 'page', 'g')).page;
    await store.append(old, page, update('private'), 'pending');
    const ban = {
      user: 'alice',
      session: 'a',
      sharedComputer: false,
      workspaces: [{ workspace: 'workspace', version: 2, allowed: false }],
    };
    await store.applyPolicy(bare, ban);
    const late = await allowedTicket(store, 'alice', 'a');
    await expect(store.open(late, 'workspace', 'page', 'g')).rejects.toThrow('désactivée');
    await expect(store.append(old, page, update('late'))).rejects.toThrow('désactivée');
    await expect(store.acknowledge(old, page, ['pending'])).rejects.toThrow('désactivée');
    expect(await store.pending('alice')).toBe(0);
    const enabled = await pagesAllowed(
      store,
      await store.applyPolicy(bare, {
        ...ban,
        workspaces: [{ workspace: 'workspace', version: 3, allowed: true }],
      }),
    );
    expect((await store.open(enabled, 'workspace', 'page', 'g')).updates).toEqual([]);
    await expect(store.open(old, 'workspace', 'page', 'g')).rejects.toThrow('désactivée');
  });
  it('workspace purge preserves other accounts and workspaces; pending writes cannot resurrect it', async () => {
    const { store } = fixture();
    const a = await allowedTicket(store, 'alice', 'a'),
      b = await allowedTicket(store, 'bob', 'b');
    const first = (await store.open(a, 'workspace', 'p', 'g')).page;
    const other = (await store.open(a, 'other', 'p', 'g')).page;
    const bob = (await store.open(b, 'workspace', 'p', 'g')).page;
    await store.append(a, other, update('other'), 'o');
    await store.append(b, bob, update('bob'), 'b');
    const queued = store.append(a, first, update('queued'), 'q').catch(() => {});
    await store.applyPolicy(a, {
      user: 'alice',
      session: 'a',
      sharedComputer: false,
      workspaces: [
        { workspace: 'workspace', version: 2, allowed: false },
        { workspace: 'other', version: 1, allowed: true },
      ],
    });
    await queued;
    expect(await store.pending('alice', 'workspace')).toBe(0);
    expect(text((await store.open(a, 'other', 'p', 'g')).updates)).toBe('other');
    expect(text((await store.open(b, 'workspace', 'p', 'g')).updates)).toBe('bob');
  });
  it('shared computer purges all user documents and permanently disables known sleeping sessions', async () => {
    const { store } = fixture();
    const a = await allowedTicket(store, 'alice', 'a'),
      late = await allowedTicket(store, 'alice', 'late'),
      b = await allowedTicket(store, 'bob', 'b');
    const page = (await store.open(a, 'workspace', 'p', 'g')).page;
    await store.append(a, page, update('private'), 'p');
    const bob = (await store.open(b, 'workspace', 'p', 'g')).page;
    await store.append(b, bob, update('bob'));
    const shared = await store.ticket('alice', 'shared');
    await store.applyPolicy(shared, {
      user: 'alice',
      session: 'shared',
      sharedComputer: true,
      workspaces: [],
    });
    await expect(store.append(late, page, update('resurrection'))).rejects.toThrow('désactivée');
    const refreshed = await allowedTicket(store, 'alice', 'late');
    await expect(store.open(refreshed, 'workspace', 'p', 'g')).rejects.toThrow('désactivée');
    const observed = await store.applyPolicy(await store.ticket('alice', 'late'), {
      user: 'alice',
      session: 'late',
      sharedComputer: false,
      workspaces: [{ workspace: 'workspace', version: 1, accessVersion: 9, allowed: true }],
    });
    expect(await store.accessStamp('alice', 'workspace')).toBe('9:false');
    await expect(store.open(observed, 'workspace', 'p', 'g')).rejects.toThrow('désactivée');
    expect(await store.pending('alice')).toBe(0);
    expect(text((await store.open(b, 'workspace', 'p', 'g')).updates)).toBe('bob');
    const fresh = await pagesAllowed(
      store,
      await store.applyPolicy(await store.ticket('alice', 'fresh-login'), {
        user: 'alice',
        session: 'fresh-login',
        sharedComputer: false,
        workspaces: [{ workspace: 'workspace', version: 1, accessVersion: 9, allowed: true }],
      }),
    );
    expect((await store.open(fresh, 'workspace', 'p', 'g')).updates).toEqual([]);
  });
  it('survives reopening, scopes user/workspace/page/generation and never mixes old generations', async () => {
    const { factory, store } = fixture(),
      ticket = await allowedTicket(store, 'alice', 'session');
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
    const bob = await allowedTicket(store, 'bob', 'session');
    expect((await store.open(bob, 'workspace', 'page', 'generation')).updates).toEqual([]);
  });
  it('merges two tabs without overwriting their work; a receipt only removes known pending tokens', async () => {
    const { store } = fixture(),
      ticket = await allowedTicket(store, 'alice', 'session');
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
      ticket = await allowedTicket(store, 'alice', 'session');
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
      ticket = await allowedTicket(store, 'alice', 'session'),
      old = await allowedTicket(store, 'alice', 'old');
    const a = await store.open(ticket, 'workspace', 'a', 'generation'),
      b = await store.open(old, 'workspace', 'b', 'generation');
    const bob = await allowedTicket(store, 'bob', 'bob'),
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
    await expect(allowedTicket(store, 'alice', 'session')).rejects.toThrow('déconnectée');
    await expect(store.assertActive(ticket)).rejects.toThrow('déconnectée');
    const fresh = await allowedTicket(store, 'alice', 'new-login');
    for (const page of ['a', 'b'])
      expect((await store.open(fresh, 'workspace', page, 'generation')).updates).toEqual([]);
    expect(text((await store.open(bob, 'workspace', 'a', 'generation')).updates)).toBe('Bob');
  });
  it('fences an obsolete writer after explicit discard; a new handle starts empty', async () => {
    const { store } = fixture(),
      ticket = await allowedTicket(store, 'alice', 'session');
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
      ticket = await allowedTicket(store, 'alice', 'session');
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
    await expect(allowedTicket(unavailable, 'alice', 'session')).rejects.toThrow('Storage denied');
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
