import { parentPort } from 'node:worker_threads';
import { IncrementalReplica } from './incremental-replica.ts';
let replica: IncrementalReplica | undefined;
parentPort!.on(
  'message',
  ({
    operation,
    snapshot,
    update,
  }: {
    operation: string;
    snapshot: Uint8Array;
    update: Uint8Array;
  }) => {
    const started = performance.now();
    try {
      let result: unknown;
      if (operation === 'init') {
        replica?.close();
        replica = new IncrementalReplica(snapshot);
      } else if (operation === 'prepare') result = replica!.prepare(update);
      else if (operation === 'commit') replica!.commit();
      else if (operation === 'abort') replica!.abort();
      else if (operation === 'snapshot') result = replica!.snapshot();
      else throw new Error('Unknown worker operation');
      parentPort!.postMessage({ result, elapsed: performance.now() - started });
    } catch (error) {
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : 'Rejected',
        validation: operation === 'prepare',
        elapsed: performance.now() - started,
      });
    }
  },
);
