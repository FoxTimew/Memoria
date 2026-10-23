import { Worker } from 'node:worker_threads';
import { once } from 'node:events';
import type { BlockEnvelope } from '@memoria/blocks-core';

export class CandidateValidator {
  private readonly worker: Worker;
  private busy = false;
  private failed = false;
  // Overrides are only used by the sizing diagnostic; the proof server keeps 250 ms/128 MiB.
  constructor(
    workerFile: URL,
    private readonly budget = { milliseconds: 250, memoryMiB: 128 },
  ) {
    this.worker = new Worker(workerFile, {
      resourceLimits: { maxOldGenerationSizeMb: budget.memoryMiB, maxYoungGenerationSizeMb: 16 },
    });
    this.worker.on('error', () => {
      this.failed = true;
    });
    this.worker.on('exit', () => {
      this.failed = true;
    });
  }
  async ready() {
    await once(this.worker, 'online');
  }
  async validate(
    base: Uint8Array,
    update: Uint8Array,
  ): Promise<{ snapshot: Uint8Array; blocks: BlockEnvelope[]; validationMs: number }> {
    if (this.busy || this.failed) throw new Error('Validator unavailable');
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
        const exit = () => fail(new Error('Validator exited'));
        const receive = (result: {
          error?: string;
          snapshot: Uint8Array;
          blocks: BlockEnvelope[];
          validationMs: number;
        }) => {
          finish();
          if (result.error) reject(new Error(result.error));
          else resolve(result);
        };
        const timer = setTimeout(() => {
          this.failed = true;
          void this.worker.terminate();
          fail(new Error(`Validation budget exceeded (${this.budget.milliseconds} ms)`));
        }, this.budget.milliseconds);
        this.worker.once('message', receive);
        this.worker.once('error', fail);
        this.worker.once('exit', exit);
        this.worker.postMessage({ base, update });
      });
    } finally {
      this.busy = false;
    }
  }
  async close() {
    await this.worker.terminate();
  }
}
