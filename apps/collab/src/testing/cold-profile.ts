// Explicit profiling runner only; neither production nor the general e2e sweep imports this.
import { after } from 'node:test';
import { AsyncLocalStorage } from 'node:async_hooks';
import { writeFile } from 'node:fs/promises';
import { FileBoundary } from '@memoria/db';
import { Room } from '../service/room.ts';
import { Store } from '../service/store.ts';
import { IncrementalValidator } from '../service/incremental-validator.ts';
import './cold.e2e.ts';

type Sample = { total: number; stages: Record<string, number>; workers: Record<string, number> };
const context = new AsyncLocalStorage<Sample>();
const samples: Sample[] = [];
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
  const sample: Sample = { total: 0, stages: {}, workers: {} };
  const start = performance.now();
  await context.run(sample, () => load.call(this));
  sample.total = performance.now() - start;
  samples.push(sample);
};
Store.prototype.load = timed('storeLoad', Store.prototype.load);
IncrementalValidator.prototype.init = timed('replicaInit', IncrementalValidator.prototype.init);
IncrementalValidator.prototype.inspect = timed(
  'inspectRoundTrip',
  IncrementalValidator.prototype.inspect,
);
Store.prototype.verifyFileLedger = timed('ledgerTransaction', Store.prototype.verifyFileLedger);
FileBoundary.prototype.verifyLedger = timed(
  'ledgerComparison',
  FileBoundary.prototype.verifyLedger,
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
  await writeFile(
    '.local/7d-cold-profile.json',
    JSON.stringify(
      {
        scope:
          'Room.load spans; replicaInit overlaps live Yjs apply; ledgerComparison is included in ledgerTransaction. Worker elapsed excludes IPC and scheduling. First two samples of each profile are the original cold harness warmup.',
        samples,
      },
      null,
      2,
    ) + '\n',
  );
});
