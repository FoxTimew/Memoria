import { parentPort } from 'node:worker_threads';
import { IncrementalReplica } from './incremental-replica.ts';
import * as Y from 'yjs';
const replicas = new Map<number, IncrementalReplica>();
const initializing = new Map<number, Y.Doc>();
parentPort!.on(
  'message',
  ({
    operation,
    id,
    replicaId,
    collect,
    snapshot,
    updates,
    update,
    operations,
  }: {
    operation: string;
    id: number;
    replicaId: number;
    collect?: boolean;
    snapshot: Uint8Array;
    updates: Uint8Array[];
    update: Uint8Array;
    operations: import('@memoria/contracts').BlockBatch['operations'];
  }) => {
    const started = performance.now();
    try {
      let result: unknown;
      const replica = replicas.get(replicaId);
      if (operation === 'init') {
        replica?.close();
        replicas.delete(replicaId);
        const initialized = new IncrementalReplica(snapshot, updates);
        replicas.set(replicaId, initialized);
        result = { encodedBytes: initialized.encodedUpperBound };
      } else if (operation === 'dispose') {
        replica?.close();
        replicas.delete(replicaId);
        initializing.get(replicaId)?.destroy();
        initializing.delete(replicaId);
      } else if (operation === 'init-start') {
        replica?.close();
        replicas.delete(replicaId);
        initializing.get(replicaId)?.destroy();
        const doc = new Y.Doc();
        doc.getXmlFragment('prosemirror');
        initializing.set(replicaId, doc);
        Y.applyUpdate(doc, snapshot);
      } else if (operation === 'init-chunk') {
        Y.applyUpdate(initializing.get(replicaId)!, Y.mergeUpdates(updates));
      } else if (operation === 'init-finish') {
        const doc = initializing.get(replicaId)!;
        const bytes = Y.encodeStateAsUpdate(doc);
        doc.destroy();
        initializing.delete(replicaId);
        const initialized = new IncrementalReplica(bytes);
        replicas.set(replicaId, initialized);
        result = { encodedBytes: initialized.encodedUpperBound };
      } else if (operation === 'metrics') {
        if (collect && typeof global.gc === 'function') global.gc();
        const memory = process.memoryUsage();
        result = {
          heapUsed: memory.heapUsed,
          external: memory.external,
          arrayBuffers: memory.arrayBuffers,
          replicas: replicas.size,
        };
      } else if (operation === 'prepare')
        result = updates ? replica!.prepareMany(updates) : replica!.prepare(update);
      else if (operation === 'command') result = replica!.command(operations);
      else if (operation === 'inspect') result = replica!.inspect();
      else if (operation === 'commit') replica!.commit();
      else if (operation === 'abort') replica!.abort();
      else if (operation === 'snapshot') result = replica!.snapshot();
      else throw new Error('Unknown worker operation');
      parentPort!.postMessage({ id, result, elapsed: performance.now() - started });
    } catch {
      parentPort!.postMessage({
        id,
        error:
          operation === 'prepare' || operation === 'command'
            ? 'INVALID_CONTENT'
            : 'REPLICA_OPERATION_FAILED',
        validation: operation === 'prepare' || operation === 'command',
        elapsed: performance.now() - started,
      });
    }
  },
);
