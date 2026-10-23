import { describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { DraftStore, needsRecovery } from './local-drafts.ts';
import { PageDraft, VersionConflict } from './page-draft.ts';
import type { Draft, DraftSnapshot } from './page-draft.ts';

const initial: Draft = { title: 'Confirmé', blocks: [] };
const snapshot = (title = 'Brouillon'): DraftSnapshot => ({
  version: 1,
  base: initial,
  draft: { ...initial, title },
  history: [],
});
function database() {
  const factory = new IDBFactory();
  return { factory, store: new DraftStore(() => factory) };
}
describe('IndexedDB draft lifecycle', () => {
  it('survives reopening, isolates user/page keys and offers only unconfirmed changes', async () => {
    const { store, factory } = database();
    const page = await store.open('alice', 'session-a', 'page-1');
    await page.sync(snapshot(), [{ type: 'paragraph' }], false);
    const reopened = await new DraftStore(() => factory).open('alice', 'session-a', 'page-1');
    expect(reopened.recovered?.snapshot.draft.title).toBe('Brouillon');
    expect(needsRecovery(reopened.recovered!, initial)).toBe(true);
    expect(needsRecovery(reopened.recovered!, snapshot().draft)).toBe(false);
    const save = vi.fn(async () => 2);
    const restored = new PageDraft(1, initial, { version: async () => 1, save }, () => {});
    restored.restore(reopened.recovered!.snapshot, 1);
    await restored.flush();
    expect(save).toHaveBeenCalledWith(1, snapshot().draft, []);
    expect(restored.status).toBe('clean');
    expect((await store.open('bob', 'session-b', 'page-1')).recovered).toBeUndefined();
    expect((await store.open('alice', 'session-a', 'page-2')).recovered).toBeUndefined();
    await reopened.discard(false);
    expect((await store.open('alice', 'session-a', 'page-1')).recovered).toBeUndefined();
    await reopened.sync(snapshot('Après abandon'), [], false);
    expect((await store.open('alice', 'session-a', 'page-1')).recovered?.snapshot.draft.title).toBe(
      'Après abandon',
    );
  });
  it('keeps network failures and conflicts, and restores the original version without silently rebasing', async () => {
    for (const failure of [new VersionConflict(), new Error('Offline')]) {
      const { store } = database();
      const page = await store.open('alice', 'session-a', 'page-1');
      const pending: Promise<unknown>[] = [];
      const draft = new PageDraft(
        1,
        initial,
        {
          version: async () => 1,
          save: async () => {
            throw failure;
          },
        },
        () => {
          pending.push(page.sync(draft.snapshot(), [], false));
        },
      );
      draft.change(snapshot().draft);
      await draft.flush();
      await Promise.all(pending);
      const recovered = (await store.open('alice', 'session-a', 'page-1')).recovered!;
      const save = vi.fn();
      const restored = new PageDraft(
        2,
        { ...initial, title: 'Modifié ailleurs' },
        { version: async () => 2, save },
        () => {},
      );
      restored.restore(recovered.snapshot, 2);
      await restored.flush();
      expect(restored.draft.title).toBe('Brouillon');
      expect(restored.version).toBe(1);
      expect(restored.status).toBe('conflict');
      expect(save).not.toHaveBeenCalled();
    }
  });
  it('removes the acknowledged draft, but preserves edits entered during an in-flight save', async () => {
    const { store } = database();
    const page = await store.open('alice', 'session-a', 'page-1');
    const writes: Promise<unknown>[] = [];
    let remote = 1;
    let finish!: (version: number) => void;
    const save = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const draft = new PageDraft(1, initial, { version: async () => remote, save }, () => {
      writes.push(page.sync(draft.snapshot(), [], false));
    });
    draft.change(snapshot('Première saisie').draft);
    const first = draft.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    draft.change(snapshot('Saisie pendant envoi').draft);
    remote = 2;
    finish(2);
    await first;
    await Promise.all(writes);
    const persisted = (await store.open('alice', 'session-a', 'page-1')).recovered!;
    expect(persisted.snapshot.base.title).toBe('Première saisie');
    expect(persisted.snapshot.draft.title).toBe('Saisie pendant envoi');
    expect(persisted.snapshot.version).toBe(2);
    const second = draft.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledTimes(2));
    remote = 3;
    finish(3);
    await second;
    await Promise.all(writes);
    expect((await store.open('alice', 'session-a', 'page-1')).recovered).toBeUndefined();
  });
  it('does not let an older tab acknowledgement or discard delete another tab’s newer draft', async () => {
    const { store } = database();
    const a = await store.open('alice', 'session-a', 'page-1');
    await a.sync(snapshot('A'), [], false);
    const b = await store.open('alice', 'session-a', 'page-1');
    await b.sync(snapshot('B'), [], false);
    // A status-only update (for example conflict polling) is not a newer local edit.
    await a.sync(snapshot('A'), [], false);
    expect((await store.open('alice', 'session-a', 'page-1')).recovered?.snapshot.draft.title).toBe(
      'B',
    );
    await a.sync({ ...snapshot('A'), base: snapshot('A').draft, version: 2 }, [], false);
    await a.discard();
    expect((await store.open('alice', 'session-a', 'page-1')).recovered?.snapshot.draft.title).toBe(
      'B',
    );
    await b.discard();
    expect((await store.open('alice', 'session-a', 'page-1')).recovered).toBeUndefined();
  });
  it('an explicit abandonment drains queued writes and blocks late acknowledgements from recreating the draft', async () => {
    const { store } = database();
    const page = await store.open('alice', 'session-a', 'page-1');
    const pending = page.sync(snapshot(), [], false);
    const discarded = page.discard();
    await Promise.all([pending, discarded]);
    await page.sync(snapshot('Accusé tardif'), [], false);
    expect((await store.open('alice', 'session-a', 'page-1')).recovered).toBeUndefined();
  });
  it('sign-out clears every page of that user and fences old tabs, including queued writes and reopened old sessions', async () => {
    const { store } = database();
    const a = await store.open('alice', 'session-a', 'page-1');
    const anotherSession = await store.open('alice', 'session-old', 'page-2');
    const bob = await store.open('bob', 'session-b', 'page-1');
    await Promise.all([
      a.sync(snapshot(), [], false),
      anotherSession.sync(snapshot(), [], false),
      bob.sync(snapshot(), [], false),
    ]);
    const pending = a.sync(snapshot('Avant sortie'), [], false).catch(() => {});
    await store.clearUser('alice', 'session-a');
    await pending;
    await expect(a.sync(snapshot('Après sortie'), [], false)).rejects.toThrow('déconnectée');
    await expect(anotherSession.sync(snapshot('Ancien onglet'), [], false)).rejects.toThrow(
      'déconnectée',
    );
    await expect(store.open('alice', 'session-a', 'page-1')).rejects.toThrow();
    expect((await store.open('alice', 'new-login', 'page-1')).recovered).toBeUndefined();
    expect((await store.open('alice', 'new-login', 'page-2')).recovered).toBeUndefined();
    expect((await store.open('bob', 'session-b', 'page-1')).recovered).toBeDefined();
  });
  it('preserves raw unsupported editor data even when the last convertible draft equals the server', async () => {
    const { store } = database();
    const page = await store.open('alice', 'session-a', 'page-1');
    await page.sync(
      { ...snapshot(), draft: initial },
      [{ type: 'future-widget', content: 'Texte à conserver' }],
      true,
    );
    const recovered = (await store.open('alice', 'session-a', 'page-1')).recovered!;
    expect(needsRecovery(recovered, initial)).toBe(true);
    expect(recovered.editorDocument).toEqual([
      { type: 'future-widget', content: 'Texte à conserver' },
    ]);
  });
  it('reports unavailable storage and transaction failures instead of claiming persistence', async () => {
    const store = new DraftStore(() => {
      throw new Error('Storage denied');
    });
    await expect(store.open('alice', 'session-a', 'page-1')).rejects.toThrow('Storage denied');
    await expect(store.clearUser('alice', 'session-a')).rejects.toThrow('Storage denied');
    const working = database().store;
    const page = await working.open('alice', 'session-a', 'page-1');
    const write = vi.spyOn(working, 'write').mockRejectedValueOnce(new Error('QuotaExceededError'));
    await expect(page.sync(snapshot(), [], false)).rejects.toThrow('QuotaExceededError');
    write.mockRestore();
    await page.sync(snapshot('Après erreur'), [], false);
    await page.discard();
    expect((await working.open('alice', 'session-a', 'page-1')).recovered).toBeUndefined();
  });
});
