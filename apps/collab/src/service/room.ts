import * as Y from 'yjs';
import type { CollaborationCommand } from '@memoria/contracts';
import type { AccessRequest } from './access.ts';
import { CandidateRejected } from '../validator.ts';
import { IncrementalValidator } from './incremental-validator.ts';
import type { ValidationPool } from './validation-pool.ts';
import { RoomBatchQueue } from './room-batch-queue.ts';
import { Store, receiptFor, digest } from './store.ts';
import { CollaborationError } from './internal-server.ts';
import { replicaReservation } from './memory.ts';
import { FileFault } from '@memoria/db';
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
  replica: IncrementalValidator;
  private recovery: Promise<void> | undefined;
  private closed = false;
  private encodedUpperBound = 0;
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
    private readonly pool?: ValidationPool,
    private readonly reserve: (bytes: number) => Promise<void> = async () => {},
    private readonly weight = 1,
  ) {
    this.replica = this.createReplica();
    this.queue = new RoomBatchQueue((entries) => this.process(entries));
  }
  private createReplica() {
    return new IncrementalValidator(
      this.pool,
      () => {
        if (this.closed) return;
        this.fatal = true;
        this.onFatal();
      },
      this.encodedUpperBound ? replicaReservation(this.encodedUpperBound) : this.weight,
    );
  }
  get recovering() {
    return !!this.recovery;
  }
  recover() {
    if (this.recovery) return this.recovery;
    this.fatal = true;
    this.recovery = (async () => {
      // Includes in-flight SQL commits: an update may be durable despite a lost worker reply.
      while (this.pending) await new Promise((resolve) => setTimeout(resolve, 10));
      if (this.closed) throw new Error('ROOM_CLOSED');
      await this.replica.close();
      this.replica = this.createReplica();
      await this.load();
      this.fatal = false;
    })().finally(() => {
      this.recovery = undefined;
    });
    return this.recovery;
  }
  async load() {
    const loaded = await this.store.load(this.page, this.generation);
    this.encodedUpperBound = loaded.updates.reduce(
      (sum, update) => sum + update.length,
      loaded.snapshot.length,
    );
    await this.reserve(this.encodedUpperBound);
    const init = this.replica.init(loaded.snapshot, loaded.updates);
    this.doc.getXmlFragment('prosemirror');
    Y.applyUpdate(
      this.doc,
      loaded.updates.length
        ? Y.mergeUpdates([loaded.snapshot, ...loaded.updates])
        : loaded.snapshot,
    );
    this.encodedUpperBound = (await init).encodedBytes;
    await this.reserve(this.encodedUpperBound);
    this.replica.resize(replicaReservation(this.encodedUpperBound));
    this.revision = Number(loaded.state.content_revision);
    const blocks = await this.replica.inspect();
    await this.store.verifyFileLedger(
      this.page,
      this.generation,
      this.revision,
      blocks
        .filter((b) => b.type === 'core.image' && typeof b.content.fileId === 'string')
        .map((b) => ({ slot: b.id, file: b.content.fileId as string })),
    );
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
        // Commands can replace the complete content; reserve their maximum candidate first.
        await this.reserve(1024 ** 2);
        validation = await this.replica.command(command.operations);
        update = validation.update;
      } else {
        update = Y.mergeUpdates(entries.map((e) => ('update' in e ? e.update : new Uint8Array())));
        await this.reserve(Math.min(1024 ** 2, this.encodedUpperBound + update.length));
        validation = await this.replica.prepareMany(
          entries.map((e) => ('update' in e ? e.update : new Uint8Array())),
        );
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
      await this.reserve(validation.encodedUpperBound);
      const next = await this.store.append(
        this.generation,
        this.revision,
        contributions,
        update,
        validation.blocks,
        validation.blockIdsToReserve,
        validation.fileSteps,
      );
      committed = true;
      await this.replica.commit();
      Y.applyUpdate(this.doc, update);
      this.revision = next.revision;
      this.encodedUpperBound = validation.encodedUpperBound;
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
          await this.reserve(this.encodedUpperBound);
        } catch {
          this.fatal = true;
          this.onFatal();
        }
      }
      if (error instanceof FileFault) throw new CollaborationError(error.code, error.status);
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
    this.closed = true;
    await this.recovery?.catch(() => {});
    await this.replica.close();
  }
}
