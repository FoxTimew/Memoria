// Persistent isolated validator. No live document is ever mutated before SQL commit.
import * as Y from 'yjs';
import { applyCommands } from './commands.ts';
import type { BlockBatch } from '@memoria/contracts';
import { bounds, decodeDocument } from '../codec.ts';
import type { ContentIndex } from '../codec.ts';
import type { BlockEnvelope } from '@memoria/blocks-core';

export class IncrementalReplica {
  doc!: Y.Doc;
  private index!: ContentIndex;
  private checkpoint: Uint8Array;
  private accepted: Uint8Array[] = [];
  private pending: { update: Uint8Array; upper: number; blockIds: Set<string> } | undefined;
  private committedBlockIds = new Set<string>();
  private tainted = false;
  private upper = 0;
  private blocks: BlockEnvelope[] = [];
  constructor(snapshot: Uint8Array, updates: Uint8Array[] = []) {
    if (snapshot.length > bounds.document) throw new Error('Maximum base size');
    this.checkpoint = new Uint8Array(snapshot);
    this.accepted = updates.map((update) => new Uint8Array(update));
    this.reset();
  }
  private reset() {
    this.doc?.destroy();
    this.doc = new Y.Doc();
    this.doc.getXmlFragment('prosemirror');
    // Replay in one Yjs transaction: each apply otherwise copies the full historical state vector.
    Y.applyUpdate(
      this.doc,
      this.accepted.length ? Y.mergeUpdates([this.checkpoint, ...this.accepted]) : this.checkpoint,
    );
    this.index = { content: new WeakMap(), checked: 0, jsonBytes: 0, structures: 0 };
    for (const entries of this.doc.store.clients.values())
      for (const item of entries) this.index.structures += item.length;
    this.blocks = decodeDocument(this.doc, this.index);
    // Same conservative sum bound as prepare(); re-encode only when needed to prove the ceiling.
    this.upper = this.accepted.reduce((sum, update) => sum + update.length, this.checkpoint.length);
    if (this.upper > bounds.document) this.upper = Y.encodeStateAsUpdate(this.doc).length;
    if (this.upper > bounds.document) throw new Error('Maximum document size');
    this.pending = undefined;
    this.tainted = false;
    this.doc.on('afterTransaction', (transaction: Y.Transaction) => {
      // Revalidate the whole content of every touched block; structural metadata is always walked.
      for (const changed of transaction.changed.keys()) {
        let node = changed as unknown as Y.XmlElement | Y.XmlText;
        while (node) {
          if (node instanceof Y.XmlElement && node.nodeName === 'blockContainer') {
            const content = node.length ? node.get(0) : undefined;
            if (content instanceof Y.XmlElement) this.index.content.delete(content);
            break;
          }
          node = node.parent as Y.XmlElement | Y.XmlText;
        }
      }
    });
  }
  prepare(update: Uint8Array) {
    if (this.pending || this.tainted) throw new Error('Replica needs commit or abort');
    if (update.length > bounds.update) throw new Error('Maximum update size');
    try {
      // Only clock changes from clients in this update. No history-wide structure scan.
      const meta = Y.parseUpdateMeta(update);
      const clock = (client: number) => {
        const last = this.doc.store.clients.get(client)?.at(-1);
        return last ? last.id.clock + last.length : 0;
      };
      const before = new Map([...meta.to.keys()].map((client) => [client, clock(client)]));
      Y.applyUpdate(this.doc, update);
      for (const [client, previous] of before) this.index.structures += clock(client) - previous;
      this.blocks = decodeDocument(this.doc, this.index);
      // mergeUpdates' sum bound also bounds a GC'ed snapshot. Re-encode only near the ceiling.
      let upper = this.upper + update.length;
      if (upper > bounds.document) upper = Y.encodeStateAsUpdate(this.doc).length;
      if (upper > bounds.document) throw new Error('Maximum document size');
      const blockIds = new Set(this.blocks.map((b) => b.id));
      this.pending = { update: new Uint8Array(update), upper, blockIds };
      return {
        blocks: this.blocks.filter((b) => b.type === 'core.image'),
        // Ownership is immutable. Reuse it only after the caller confirms a durable SQL commit.
        // A fresh replica checks all IDs; deleted and later reintroduced IDs are checked again.
        blockIdsToReserve: [...blockIds].filter((id) => !this.committedBlockIds.has(id)),
        checkedBlocks: this.index.checked,
        jsonBytes: this.index.jsonBytes,
        encodedUpperBound: upper,
      };
    } catch (error) {
      this.tainted = true;
      throw error;
    }
  }
  commit() {
    if (!this.pending || this.tainted) throw new Error('Nothing valid to commit');
    this.accepted.push(this.pending.update);
    this.upper = this.pending.upper;
    this.committedBlockIds = this.pending.blockIds;
    this.pending = undefined;
    if (
      this.accepted.reduce((sum, u) => sum + u.length, 0) >= 1024 ** 2 ||
      this.accepted.length >= 500
    )
      this.checkpointNow();
  }
  abort() {
    this.reset();
  }
  inspect() {
    return this.blocks;
  }
  snapshot() {
    if (this.pending || this.tainted) throw new Error('Uncommitted replica');
    return Y.encodeStateAsUpdate(this.doc);
  }
  command(operations: BlockBatch['operations']) {
    const candidate = new Y.Doc();
    candidate.getXmlFragment('prosemirror');
    try {
      Y.applyUpdate(candidate, this.snapshot());
      const before = Y.encodeStateVector(candidate);
      applyCommands(candidate, operations);
      const update = Y.encodeStateAsUpdate(candidate, before);
      return { update, ...this.prepare(update) };
    } finally {
      candidate.destroy();
    }
  }
  checkpointNow() {
    this.checkpoint = this.snapshot();
    this.accepted = [];
  }
  close() {
    this.doc.destroy();
  }
}
