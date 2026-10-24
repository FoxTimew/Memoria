import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { CandidateRejected } from '../validator.ts';
export const defaultValidationWorkers = () =>
  Math.max(1, Math.min(4, Math.floor(availableParallelism() / 2)));
type Reply = { result: unknown; elapsed: number };
type Job = {
  id: number;
  replica: number;
  operation: string;
  data: object;
  deadline: number;
  bytes: number;
  resolve: (reply: Reply) => void;
  reject: (error: Error) => void;
};
type Slot = {
  id: number;
  worker: Worker;
  failed: boolean;
  replicas: Map<number, { fault: () => void; weight: number }>;
  queue: Job[];
  bytes: number;
  active?: Job;
  timer?: ReturnType<typeof setTimeout>;
};
export type PoolMetrics = {
  heapUsed: number;
  external: number;
  arrayBuffers: number;
  replicas: number;
};
/** Affinity by reservation weight; one dispatched operation per worker, bounded queues. */
export class ValidationPool {
  private slots = new Set<Slot>();
  private nextId = 0;
  private stopped = false;
  private terminating = new Set<Promise<number>>();
  constructor(
    readonly size = defaultValidationWorkers(),
    readonly memoryMiB = 256,
  ) {
    if (!Number.isInteger(size) || size < 1 || size > 8)
      throw new Error('Invalid worker pool size');
  }
  private createSlot() {
    const worker = new Worker(new URL('./incremental-worker.mjs', import.meta.url), {
      resourceLimits: { maxOldGenerationSizeMb: this.memoryMiB, maxYoungGenerationSizeMb: 16 },
    });
    const slot: Slot = {
      id: ++this.nextId,
      worker,
      failed: false,
      replicas: new Map(),
      queue: [],
      bytes: 0,
    };
    this.slots.add(slot);
    worker.on('error', (error) => this.fail(slot, error));
    worker.on('exit', () => this.fail(slot, new Error('Replica worker exited')));
    worker.on(
      'message',
      (message: Reply & { id: number; error?: string; validation?: boolean }) => {
        const job = slot.active;
        if (!job || message.id !== job.id) {
          this.fail(slot, new Error('Worker reply mismatch'));
          return;
        }
        clearTimeout(slot.timer);
        delete slot.active;
        slot.bytes -= job.bytes;
        if (message.error)
          job.reject(
            message.validation ? new CandidateRejected(message.error) : new Error(message.error),
          );
        else job.resolve(message);
        this.dispatch(slot);
      },
    );
    return slot;
  }
  private fail(slot: Slot, error: Error) {
    if (slot.failed) return;
    slot.failed = true;
    this.slots.delete(slot);
    clearTimeout(slot.timer);
    slot.active?.reject(error);
    delete slot.active;
    for (const job of slot.queue.splice(0)) job.reject(error);
    slot.bytes = 0;
    const faults = [...slot.replicas.values()];
    slot.replicas.clear();
    const termination = slot.worker.terminate();
    this.terminating.add(termination);
    void termination.then(
      () => this.terminating.delete(termination),
      () => this.terminating.delete(termination),
    );
    for (const { fault } of faults) fault();
  }
  private dispatch(slot: Slot) {
    if (slot.failed || slot.active) return;
    const job = slot.queue.shift();
    if (!job) return;
    slot.active = job;
    slot.timer = setTimeout(
      () => this.fail(slot, new Error(`Replica budget exceeded (${job.deadline} ms)`)),
      job.deadline,
    );
    // Node queues messages during startup. Init has a separate 30s deadline.
    try {
      slot.worker.postMessage({
        id: job.id,
        replicaId: job.replica,
        operation: job.operation,
        ...job.data,
      });
    } catch (error) {
      this.fail(slot, error instanceof Error ? error : new Error('Worker dispatch failed'));
    }
  }
  private enqueue(
    slot: Slot,
    replica: number,
    operation: string,
    data: object,
    deadline: number,
  ): Promise<Reply> {
    if (this.stopped || slot.failed) return Promise.reject(new Error('Replica worker unavailable'));
    const input = data as {
      snapshot?: Uint8Array;
      updates?: Uint8Array[];
      update?: Uint8Array;
      operations?: unknown;
    };
    const bytes =
      (input.snapshot?.byteLength ?? 0) +
      (input.update?.byteLength ?? 0) +
      (input.updates?.reduce((sum, update) => sum + update.byteLength, 0) ?? 0) +
      (input.operations ? Buffer.byteLength(JSON.stringify(input.operations)) : 0);
    // Disposal is one zero-payload control per bounded resident replica; it must never leak a tree.
    if (
      operation !== 'dispose' &&
      (slot.queue.length >= 128 || slot.bytes + bytes > 16 * 1024 ** 2)
    )
      return Promise.reject(new Error('VALIDATION_QUEUE_CAPACITY'));
    return new Promise((resolve, reject) => {
      slot.bytes += bytes;
      slot.queue.push({
        id: ++this.nextId,
        replica,
        operation,
        data,
        deadline,
        bytes,
        resolve,
        reject,
      });
      this.dispatch(slot);
    });
  }
  allocate(onFault: () => void = () => {}, weight = 1) {
    if (this.stopped) throw new Error('Worker pool closed');
    const totalWeight = (slot: Slot) =>
      [...slot.replicas.values()].reduce((sum, item) => sum + item.weight, 0);
    const slot =
      this.slots.size < this.size
        ? this.createSlot()
        : [...this.slots].sort((a, b) => totalWeight(a) - totalWeight(b))[0]!;
    const replica = ++this.nextId;
    let closed = false;
    slot.replicas.set(replica, { fault: onFault, weight });
    const request = (operation: string, data: object = {}, deadline = 250) =>
      closed
        ? Promise.reject(new Error('Replica closed'))
        : this.enqueue(slot, replica, operation, data, deadline);
    return {
      workerId: slot.id,
      request,
      resize(weight: number) {
        const entry = slot.replicas.get(replica);
        if (entry) entry.weight = weight;
      },
      close: async () => {
        if (closed) return;
        try {
          if (!slot.failed && !this.stopped) await request('dispose', {}, 30000);
        } finally {
          closed = true;
          slot.replicas.delete(replica);
        }
      },
    };
  }
  get stats() {
    return [...this.slots].map((slot) => ({
      id: slot.id,
      replicas: slot.replicas.size,
      waiting: slot.queue.length,
      bytes: slot.bytes,
    }));
  }
  async sample(collect = false) {
    return Promise.all(
      [...this.slots].map(async (slot) => ({
        workerId: slot.id,
        ...((await this.enqueue(slot, 0, 'metrics', { collect }, 30000)).result as PoolMetrics),
      })),
    );
  }
  /** Same failure path as an uncaught exception/OOM; used by real recovery tests. */
  async terminateWorker(id: number) {
    const slot = [...this.slots].find((slot) => slot.id === id);
    if (!slot) throw new Error('Unknown worker');
    await slot.worker.terminate();
  }
  async close() {
    this.stopped = true;
    for (const slot of this.slots) this.fail(slot, new Error('Worker pool closed'));
    await Promise.all(this.terminating);
  }
}
