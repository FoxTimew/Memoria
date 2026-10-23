// Experimental persistent validator. No live document is ever mutated before SQL commit.
import * as Y from 'yjs';
import { bounds, decodeDocument } from '../codec.ts';
import type { ContentIndex } from '../codec.ts';
import type { BlockEnvelope } from '@memoria/blocks-core';

export class IncrementalReplica {
  doc!: Y.Doc;
  private index!: ContentIndex;
  private checkpoint: Uint8Array;
  private accepted: Uint8Array[] = [];
  private pending: { update: Uint8Array; upper: number } | undefined;
  private tainted = false;
  private upper = 0;
  private blocks: BlockEnvelope[] = [];
  constructor(snapshot: Uint8Array) {
    if (snapshot.length > bounds.document) throw new Error('Maximum base size');
    this.checkpoint = new Uint8Array(snapshot);
    this.reset();
  }
  private reset() {
    this.doc?.destroy();
    this.doc = new Y.Doc();
    this.doc.getXmlFragment('prosemirror');
    Y.applyUpdate(this.doc, this.checkpoint);
    for (const update of this.accepted) Y.applyUpdate(this.doc, update);
    this.index = { content: new WeakMap(), checked: 0, jsonBytes: 0, structures: 0 };
    for (const entries of this.doc.store.clients.values())
      for (const item of entries) this.index.structures += item.length;
    this.blocks = decodeDocument(this.doc, this.index);
    this.upper = Y.encodeStateAsUpdate(this.doc).length;
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
      this.pending = { update: new Uint8Array(update), upper };
      return {
        blocks: this.blocks.filter((b) => b.type === 'core.image'),
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
    this.pending = undefined;
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
  close() {
    this.doc.destroy();
  }
}
