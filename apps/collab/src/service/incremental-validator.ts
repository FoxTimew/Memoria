import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import type { IncrementalReplica } from './incremental-replica.ts';
import { CandidateRejected } from '../validator.ts';
export class IncrementalValidator {
  private worker: Worker;
  private failed = false;
  private busy = false;
  private online: Promise<unknown[]>;
  constructor(
    private readonly budgetMs = 250,
    memoryMiB = 128,
  ) {
    this.worker = new Worker(new URL('./incremental-worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: memoryMiB, maxYoungGenerationSizeMb: 16 },
    });
    this.online = once(this.worker, 'online');
    this.worker.on('error', () => {
      this.failed = true;
    });
    this.worker.on('exit', () => {
      this.failed = true;
    });
  }
  async init(snapshot: Uint8Array, updates: Uint8Array[] = []) {
    await this.online;
    await this.request('init', { snapshot, updates }, 30000);
  }
  private async request(
    operation: string,
    data: object = {},
    deadline = this.budgetMs,
  ): Promise<{ result: unknown; elapsed: number }> {
    if (this.busy || this.failed) throw new Error('Replica worker unavailable');
    this.busy = true;
    try {
      return await new Promise((resolve, reject) => {
        const finish = () => {
          clearTimeout(timer);
          this.worker.off('message', receive);
          this.worker.off('error', fail);
          this.worker.off('exit', exit);
        };
        const fail = (error: Error) => {
          finish();
          reject(error);
        };
        const exit = () => fail(new Error('Replica worker exited'));
        const receive = (message: {
          result: unknown;
          elapsed: number;
          error?: string;
          validation?: boolean;
        }) => {
          finish();
          if (message.error)
            reject(
              message.validation ? new CandidateRejected(message.error) : new Error(message.error),
            );
          else resolve(message);
        };
        const timer = setTimeout(() => {
          this.failed = true;
          void this.worker.terminate();
          fail(new Error(`Replica budget exceeded (${deadline} ms)`));
        }, deadline);
        this.worker.once('message', receive);
        this.worker.once('error', fail);
        this.worker.once('exit', exit);
        this.worker.postMessage({ operation, ...data });
      });
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
    await this.worker.terminate();
  }
}
