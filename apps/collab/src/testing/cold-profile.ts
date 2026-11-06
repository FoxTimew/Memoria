// Explicit profiling runner only; neither production nor the general e2e sweep imports this.
import { after } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { PerformanceObserver } from 'node:perf_hooks';
import { setImmediate } from 'node:timers/promises';
import * as databaseModule from '@memoria/db';
import type { FileBoundary } from '@memoria/db';
import { Room } from '../service/room.ts';
import { Store } from '../service/store.ts';
import { IncrementalValidator } from '../service/incremental-validator.ts';
import { ValidationPool } from '../service/validation-pool.ts';
import './cold.e2e.ts';

type Sample = {
  total: number;
  started: number;
  ended: number;
  heapBefore: number;
  heapAfter: number;
  processCpuUs: { user: number; system: number };
  stages: Record<string, number>;
  workers: Record<string, number>;
};
const context = new AsyncLocalStorage<Sample>();
const samples: Sample[] = [];
const workerEvents: { operation: string; profile: unknown }[] = [];
const queue = ValidationPool.prototype as unknown as {
  enqueue(
    ...args: unknown[]
  ): Promise<{ result: unknown; elapsed: number; profileWorker?: unknown }>;
};
const enqueue = queue.enqueue;
queue.enqueue = async function (...args) {
  const reply = await enqueue.apply(this, args);
  if (reply.profileWorker)
    workerEvents.push({ operation: String(args[2]), profile: reply.profileWorker });
  return reply;
};
const gc: { start: number; duration: number; kind: number | null }[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    gc.push({
      start: entry.startTime,
      duration: entry.duration,
      kind: (entry as unknown as { detail?: { kind: number } }).detail?.kind ?? null,
    });
});
observer.observe({ entryTypes: ['gc'] });
function timed<This, Args extends unknown[], Result>(
  name: string,
  original: (this: This, ...args: Args) => Promise<Result>,
) {
  return async function (this: This, ...args: Args): Promise<Result> {
    const sample = context.getStore(),
      start = performance.now();
    try {
      return await original.apply(this, args);
    } finally {
      if (sample) sample.stages[name] = (sample.stages[name] ?? 0) + performance.now() - start;
    }
  };
}
const load = Room.prototype.load;
Room.prototype.load = async function () {
  const cpu = process.cpuUsage();
  const sample: Sample = {
    total: 0,
    started: performance.now(),
    ended: 0,
    heapBefore: process.memoryUsage().heapUsed,
    heapAfter: 0,
    processCpuUs: { user: 0, system: 0 },
    stages: {},
    workers: {},
  };
  const start = performance.now();
  await context.run(sample, () => load.call(this));
  sample.total = performance.now() - start;
  sample.ended = performance.now();
  sample.heapAfter = process.memoryUsage().heapUsed;
  sample.processCpuUs = process.cpuUsage(cpu);
  samples.push(sample);
};
Store.prototype.load = timed('storeLoad', Store.prototype.load);
IncrementalValidator.prototype.init = timed('replicaInit', IncrementalValidator.prototype.init);
IncrementalValidator.prototype.inspect = timed(
  'inspectRoundTrip',
  IncrementalValidator.prototype.inspect,
);
if (typeof Store.prototype.verifyFileLedger === 'function')
  Store.prototype.verifyFileLedger = timed('ledgerTransaction', Store.prototype.verifyFileLedger);
// Session 6 main has no file ledger. Preserve its implementation unchanged.
const fileBoundary = (databaseModule as { FileBoundary?: { prototype: FileBoundary } })
  .FileBoundary;
if (fileBoundary)
  fileBoundary.prototype.verifyLedger = timed(
    'ledgerComparison',
    fileBoundary.prototype.verifyLedger,
  );
// Observe the existing worker elapsed value; never replace a result, timeout or error.
const internal = IncrementalValidator.prototype as unknown as {
  request(
    operation: string,
    data?: object,
    deadline?: number,
  ): Promise<{ result: unknown; elapsed: number }>;
};
const request = internal.request;
internal.request = async function (...args) {
  const sample = context.getStore();
  const reply = await request.apply(this, args);
  if (sample) sample.workers[args[0]] = (sample.workers[args[0]] ?? 0) + reply.elapsed;
  return reply;
};
after(async () => {
  await setImmediate();
  await setImmediate();
  observer.disconnect();
  await writeFile(
    '.local/7d-cold-profile.json',
    JSON.stringify(
      {
        scope:
          'Room.load spans; replicaInit overlaps live Yjs apply; ledgerComparison is included in ledgerTransaction. Worker elapsed excludes IPC and scheduling. GC entries and heap are main-thread only; process CPU includes workers. First two samples of each profile are the original cold harness warmup.',
        samples,
        gc,
        origin: performance.timeOrigin,
        workerEvents,
      },
      null,
      2,
    ) + '\n',
  );
});
