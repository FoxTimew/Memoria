import type { IncrementalReplica } from './incremental-replica.ts';
import { ValidationPool } from './validation-pool.ts';
export class IncrementalValidator {
  private readonly pool: ValidationPool;
  private readonly handle: ReturnType<ValidationPool['allocate']>;
  private busy = false;
  private readonly owned: boolean;
  constructor(pool?: ValidationPool, onFault: () => void = () => {}, weight = 1) {
    this.owned = !pool;
    this.pool = pool ?? new ValidationPool(1, 128);
    this.handle = this.pool.allocate(onFault, weight);
  }
  get workerId() {
    return this.handle.workerId;
  }
  resize(weight: number) {
    this.handle.resize(weight);
  }
  async init(snapshot: Uint8Array, updates: Uint8Array[] = []) {
    if (updates.reduce((sum, update) => sum + update.length, snapshot.length) <= 8 * 1024 ** 2)
      return (await this.request('init', { snapshot, updates }, 30000)).result as {
        encodedBytes: number;
      };
    // A delayed projection can leave a long journal for a small document. Stream bounded
    // chunks through the same worker instead of permanently rejecting its reload.
    await this.request('init-start', { snapshot }, 30000);
    let chunk: Uint8Array[] = [],
      bytes = 0;
    for (const update of updates) {
      if (bytes + update.length > 8 * 1024 ** 2) {
        await this.request('init-chunk', { updates: chunk }, 30000);
        chunk = [];
        bytes = 0;
      }
      chunk.push(update);
      bytes += update.length;
    }
    if (chunk.length) await this.request('init-chunk', { updates: chunk }, 30000);
    return (await this.request('init-finish', {}, 30000)).result as { encodedBytes: number };
  }
  private async request(operation: string, data: object = {}, deadline = 250) {
    if (this.busy) throw new Error('Replica worker busy');
    this.busy = true;
    try {
      return await this.handle.request(operation, data, deadline);
    } finally {
      this.busy = false;
    }
  }
  async prepare(update: Uint8Array) {
    const result = await this.request('prepare', { update });
    return {
      ...(result.result as ReturnType<IncrementalReplica['prepare']>),
      validationMs: result.elapsed,
    };
  }
  async prepareMany(updates: Uint8Array[]) {
    const result = await this.request('prepare', { updates });
    return {
      ...(result.result as ReturnType<IncrementalReplica['prepareMany']>),
      validationMs: result.elapsed,
    };
  }
  async command(operations: import('@memoria/contracts').BlockBatch['operations']) {
    return (await this.request('command', { operations }, 5000)).result as ReturnType<
      IncrementalReplica['command']
    >;
  }
  async inspect() {
    return (await this.request('inspect', {}, 30000)).result as ReturnType<
      IncrementalReplica['inspect']
    >;
  }
  async commit() {
    await this.request('commit');
  }
  async abort() {
    await this.request('abort', {}, 30000);
  }
  async snapshot() {
    return (await this.request('snapshot', {}, 30000)).result as Uint8Array;
  }
  async close() {
    try {
      await this.handle.close();
    } finally {
      if (this.owned) await this.pool.close();
    }
  }
}
