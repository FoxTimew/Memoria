import * as Y from 'yjs';
import { parentPort } from 'node:worker_threads';
import { IncrementalReplica } from './incremental-replica.ts';
let replica: IncrementalReplica | undefined;
parentPort!.on(
  'message',
  ({
    operation,
    snapshot,
    updates,
    update,
    operations,
  }: {
    operation: string;
    snapshot: Uint8Array;
    updates: Uint8Array[];
    update: Uint8Array;
    operations: import('@memoria/contracts').BlockBatch['operations'];
  }) => {
    const started = performance.now();
    try {
      let result: unknown;
      if (operation === 'init') {
        replica?.close();
        if (updates.length) {
          const loaded = new Y.Doc();
          loaded.getXmlFragment('prosemirror');
          try {
            Y.applyUpdate(loaded, snapshot);
            for (const u of updates) Y.applyUpdate(loaded, u);
            replica = new IncrementalReplica(Y.encodeStateAsUpdate(loaded));
          } finally {
            loaded.destroy();
          }
        } else replica = new IncrementalReplica(snapshot);
      } else if (operation === 'prepare') result = replica!.prepare(update);
      else if (operation === 'command') result = replica!.command(operations);
      else if (operation === 'inspect') result = replica!.inspect();
      else if (operation === 'commit') replica!.commit();
      else if (operation === 'abort') replica!.abort();
      else if (operation === 'snapshot') result = replica!.snapshot();
      else throw new Error('Unknown worker operation');
      parentPort!.postMessage({ result, elapsed: performance.now() - started });
    } catch (error) {
      parentPort!.postMessage({
        error: error instanceof Error ? error.message : 'Rejected',
        validation: operation === 'prepare' || operation === 'command',
        elapsed: performance.now() - started,
      });
    }
  },
);
