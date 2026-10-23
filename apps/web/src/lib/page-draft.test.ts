import { describe, expect, it, vi } from 'vitest';
import { PageDraft, draftOperations, VersionConflict } from './page-draft.ts';
import type { DraftBlock } from '@memoria/block-catalog/client';
const block: DraftBlock = {
  id: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  parentId: null,
  afterId: null,
  type: 'core.paragraph',
  schemaVersion: 1,
  content: { spans: [] },
};
const initial = { title: 'Initial', blocks: [block] };
describe('autosave and conflict preservation', () => {
  it('never clears edits made during an in-flight save and serializes subsequent saves', async () => {
    let finish!: (version: number) => void;
    const save = vi.fn(
      () =>
        new Promise<number>((resolve) => {
          finish = resolve;
        }),
    );
    const state = new PageDraft(1, initial, { version: async () => 1, save }, () => {});
    state.change({ ...initial, title: 'First' });
    const pending = state.flush();
    await vi.waitFor(() => expect(save).toHaveBeenCalledOnce());
    state.change({ ...initial, title: 'Newer' });
    await state.flush();
    expect(save).toHaveBeenCalledOnce();
    finish(2);
    await pending;
    expect(state.draft.title).toBe('Newer');
    expect(state.status).toBe('dirty');
    expect(state.version).toBe(2);
  });
  it('preflight and periodic version changes stop writes and preserve the draft', async () => {
    const save = vi.fn();
    const state = new PageDraft(1, initial, { version: async () => 2, save }, () => {});
    state.change({ ...initial, title: 'Local' });
    await state.flush();
    expect(save).not.toHaveBeenCalled();
    expect(state.status).toBe('conflict');
    expect(state.draft.title).toBe('Local');
    await state.flush();
    expect(save).not.toHaveBeenCalled();
    const clean = new PageDraft(1, initial, { version: async () => 2, save }, () => {});
    await clean.poll();
    expect(clean.status).toBe('conflict');
  });
  it('handles the race after preflight and failed/ambiguous network responses without dropping edits', async () => {
    for (const error of [new VersionConflict(), new Error('Offline')]) {
      const state = new PageDraft(
        1,
        initial,
        {
          version: async () => 1,
          save: async () => {
            throw error;
          },
        },
        () => {},
      );
      state.change({ ...initial, title: 'Local' });
      await state.flush();
      expect(state.draft.title).toBe('Local');
      expect(state.version).toBe(1);
      expect(state.dirty).toBe(true);
      expect(state.status).toBe(error instanceof VersionConflict ? 'conflict' : 'error');
    }
  });
  it('ignores JSONB key order and restores known deleted IDs for undo', () => {
    expect(draftOperations([block], [{ ...block, content: { spans: [] } }])).toEqual([]);
    const history = new Map([[block.id, block]]);
    expect(draftOperations([], [block], history).map((op) => op.op)).toEqual(['restore', 'update']);
    expect(draftOperations([block], [])).toEqual([{ op: 'archive', id: block.id }]);
  });
});
