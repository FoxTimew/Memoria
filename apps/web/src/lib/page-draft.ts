import { canonicalJson } from '@memoria/contracts';
import type { BlockBatch } from '@memoria/contracts';
import type { DraftBlock } from '@memoria/block-catalog/client';

export type Draft = { title: string; blocks: DraftBlock[] };
export type DraftSnapshot = { version: number; base: Draft; draft: Draft; history: DraftBlock[] };
export type SaveStatus = 'clean' | 'dirty' | 'saving' | 'conflict' | 'error';
export interface DraftPort {
  version(): Promise<number>;
  save(version: number, draft: Draft, operations: BlockBatch['operations']): Promise<number>;
}
const same = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Build a bounded atomic batch; unknown IDs are inserted, known tombstones are restored (undo). */
export function draftOperations(
  base: readonly DraftBlock[],
  next: readonly DraftBlock[],
  history: ReadonlyMap<string, DraftBlock> = new Map(),
) {
  const operations: BlockBatch['operations'] = [];
  const before = new Map(base.map((b) => [b.id, b]));
  const known = new Map([...history, ...before]);
  const alive = new Set(before.keys());
  const desired = new Map(next.map((b) => [b.id, b]));
  for (const block of next) {
    const old = before.get(block.id);
    const placement = { id: block.id, parentId: block.parentId, afterId: block.afterId };
    if (!old) {
      if (known.has(block.id)) {
        if (!alive.has(block.id)) {
          operations.push({ op: 'restore', ...placement, withDescendants: false });
          alive.add(block.id);
        } else operations.push({ op: 'move', ...placement });
        operations.push({
          op: 'update',
          id: block.id,
          type: block.type,
          schemaVersion: block.schemaVersion,
          content: block.content,
        });
      } else operations.push({ op: 'insert', ...block });
    } else {
      if (
        !same(
          [old.type, old.schemaVersion, old.content],
          [block.type, block.schemaVersion, block.content],
        )
      )
        operations.push({
          op: 'update',
          id: block.id,
          type: block.type,
          schemaVersion: block.schemaVersion,
          content: block.content,
        });
      if (old.parentId !== block.parentId || old.afterId !== block.afterId)
        operations.push({ op: 'move', ...placement });
    }
    alive.add(block.id);
  }
  const removed = new Set([...alive].filter((id) => !desired.has(id)));
  for (const id of removed) {
    const parent = known.get(id)?.parentId;
    if (!parent || !removed.has(parent)) operations.push({ op: 'archive', id });
  }
  if (operations.length > 1500) throw new Error('Modification trop volumineuse.');
  return operations;
}

/** Single in-flight save; acknowledgements apply only to the captured draft. */
export class PageDraft {
  status: SaveStatus = 'clean';
  error = '';
  private base: Draft;
  private history = new Map<string, DraftBlock>();
  draft: Draft;
  constructor(
    public version: number,
    initial: Draft,
    private readonly port: DraftPort,
    private readonly changed: () => void,
  ) {
    this.base = structuredClone(initial);
    this.draft = structuredClone(initial);
  }
  get dirty() {
    return !same(this.base, this.draft);
  }
  snapshot(): DraftSnapshot {
    return structuredClone({
      version: this.version,
      base: this.base,
      draft: this.draft,
      history: [...this.history.values()],
    });
  }
  restore(snapshot: DraftSnapshot, remoteVersion: number, notify = true) {
    this.version = snapshot.version;
    this.base = structuredClone(snapshot.base);
    this.draft = structuredClone(snapshot.draft);
    this.history = new Map(snapshot.history.map((block) => [block.id, block]));
    this.status = remoteVersion !== this.version ? 'conflict' : this.dirty ? 'dirty' : 'clean';
    if (notify) this.changed();
  }
  private get saving() {
    return this.status === 'saving';
  }
  change(draft: Draft) {
    this.draft = structuredClone(draft);
    if (this.status !== 'saving' && this.status !== 'conflict')
      this.status = this.dirty ? 'dirty' : 'clean';
    this.changed();
  }
  async poll() {
    if (this.status === 'saving' || this.status === 'conflict') return;
    const expected = this.version;
    try {
      const remote = await this.port.version();
      if (!this.saving && this.version === expected && remote !== expected) {
        this.status = 'conflict';
        this.changed();
      }
    } catch {
      /* A network failure never proves the document is current; flush checks again. */
    }
  }
  async flush() {
    if (!this.dirty || this.status === 'saving' || this.status === 'conflict') return;
    const snapshot = structuredClone(this.draft);
    const expected = this.version;
    this.status = 'saving';
    this.error = '';
    this.changed();
    try {
      if ((await this.port.version()) !== expected) {
        this.status = 'conflict';
        return;
      }
      const version = await this.port.save(
        expected,
        snapshot,
        draftOperations(this.base.blocks, snapshot.blocks, this.history),
      );
      for (const block of this.base.blocks) this.history.set(block.id, block);
      this.base = snapshot;
      this.version = version;
      this.status = this.dirty ? 'dirty' : 'clean';
    } catch (error) {
      if (error instanceof VersionConflict) this.status = 'conflict';
      else {
        this.status = 'error';
        this.error = error instanceof Error ? error.message : 'Sauvegarde impossible.';
      }
    } finally {
      this.changed();
    }
  }
}
export class VersionConflict extends Error {}
