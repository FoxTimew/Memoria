import * as Y from 'yjs';
import type { CollaborationCommand } from '@memoria/contracts';
import type { AccessRequest } from './access.ts';
import { CandidateRejected } from '../validator.ts';
import { IncrementalValidator } from './incremental-validator.ts';
import { RoomBatchQueue } from './room-batch-queue.ts';
import { Store, receiptFor, digest } from './store.ts';
import { CollaborationError } from './internal-server.ts';
type WriteCommand = Extract<CollaborationCommand, { action: 'write' }>;
type Entry =
  | { identity: AccessRequest; update: Uint8Array }
  | { identity: AccessRequest; command: WriteCommand };
export interface Receipt {
  status: 'durable';
  generation: string;
  revision: number;
  receipt: string;
}
export class Room {
  readonly replica = new IncrementalValidator();
  readonly queue: RoomBatchQueue<Entry, Receipt>;
  revision = 0;
  pending = 0;
  fatal = false;
  constructor(
    readonly store: Store,
    readonly page: string,
    readonly generation: string,
    readonly doc: Y.Doc,
    private readonly onFatal: () => void,
  ) {
    this.queue = new RoomBatchQueue((entries) => this.process(entries));
  }
  async load() {
    const loaded = await this.store.load(this.page, this.generation);
    const init = this.replica.init(loaded.snapshot, loaded.updates);
    this.doc.getXmlFragment('prosemirror');
    Y.applyUpdate(this.doc, loaded.snapshot);
    for (const update of loaded.updates) Y.applyUpdate(this.doc, update);
    await init;
    this.revision = Number(loaded.state.content_revision);
  }
  private async enqueue(entry: Entry) {
    this.pending++;
    try {
      return await this.queue.enqueue(entry);
    } finally {
      this.pending--;
    }
  }
  update(identity: AccessRequest, update: Uint8Array) {
    return this.enqueue({ identity, update });
  }
  command(identity: AccessRequest, command: WriteCommand) {
    return this.enqueue({ identity, command });
  }
  private async attempt(entries: Entry[]): Promise<Receipt[]> {
    if (this.fatal) throw new Error('ROOM_RELOAD_REQUIRED');
    let committed = false;
    try {
      let update: Uint8Array,
        validation:
          | Awaited<ReturnType<IncrementalValidator['prepare']>>
          | Awaited<ReturnType<IncrementalValidator['command']>>;
      const first = entries[0]!;
      if ('command' in first) {
        const command = first.command;
        const requestHash = digest(
          JSON.stringify({
            expectedRevision: command.expectedRevision,
            operations: command.operations,
          }),
        );
        const previous = await this.store.receipt(
          first.identity,
          this.generation,
          command.receipt,
          requestHash,
        );
        if (previous !== undefined)
          return [
            {
              status: 'durable',
              generation: this.generation,
              revision: previous,
              receipt: command.receipt,
            },
          ];
        if (command.expectedRevision !== this.revision)
          throw new CollaborationError('CONTENT_REVISION_CONFLICT', 409, {
            contentRevision: this.revision,
          });
        validation = await this.replica.command(command.operations);
        update = validation.update;
      } else {
        update = Y.mergeUpdates(entries.map((e) => ('update' in e ? e.update : new Uint8Array())));
        validation = await this.replica.prepare(update);
      }
      const contributions = entries.map((e) => ({
        identity: e.identity,
        update: 'update' in e ? e.update : update,
        receipt: 'command' in e ? e.command.receipt : receiptFor(e.update),
        ...('command' in e
          ? {
              requestHash: digest(
                JSON.stringify({
                  expectedRevision: e.command.expectedRevision,
                  operations: e.command.operations,
                }),
              ),
            }
          : {}),
      }));
      const next = await this.store.append(
        this.generation,
        this.revision,
        contributions,
        update,
        validation.blocks,
        validation.blockIds,
      );
      committed = true;
      await this.replica.commit();
      Y.applyUpdate(this.doc, update);
      this.revision = next.revision;
      return contributions.map((e, i) => ({
        status: 'durable',
        generation: this.generation,
        revision: next.revisions[i]!,
        receipt: e.receipt,
      }));
    } catch (error) {
      if (committed) {
        this.fatal = true;
        this.onFatal();
      } else {
        try {
          await this.replica.abort();
        } catch {
          this.fatal = true;
          this.onFatal();
        }
      }
      throw error;
    }
  }
  private async process(entries: Entry[]) {
    const results: (Receipt | Error)[] = [];
    for (let i = 0; i < entries.length;) {
      const start = i++;
      if ('update' in entries[start]!) while (i < entries.length && 'update' in entries[i]!) i++;
      const group = entries.slice(start, i);
      try {
        results.push(...(await this.attempt(group)));
      } catch (error) {
        // Recoverable batch rejection never disconnects innocent contributors.
        if (
          group.length > 1 &&
          (error instanceof CandidateRejected || error instanceof CollaborationError)
        ) {
          for (const entry of group) {
            try {
              results.push(...(await this.attempt([entry])));
            } catch (individual) {
              results.push(individual instanceof Error ? individual : new Error('Rejected'));
            }
          }
        } else
          for (const _entry of group) {
            void _entry;
            results.push(error instanceof Error ? error : new Error('Rejected'));
          }
      }
    }
    return results;
  }
  async close() {
    await this.replica.close();
  }
}
