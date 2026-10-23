import { readFile, writeFile } from 'node:fs/promises';
import { freemem, totalmem } from 'node:os';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { IncrementalReplica } from './incremental-replica.ts';
import { decodeDocument } from '../codec.ts';
import { distribution } from './metrics.ts';
const memory = () => {
  global.gc!();
  global.gc!();
  return process.memoryUsage();
};
const reports = [];
for (const profile of process.argv.includes('--history-only')
  ? ['history-1M']
  : ['content-1M', 'history-1M']) {
  const snapshot = new Uint8Array(await readFile(`.local/incremental/${profile}.bin`));
  const replicas: IncrementalReplica[] = [];
  const baseline = memory(),
    available = freemem();
  const samples = [];
  let stopReason: string | undefined;
  try {
    for (let count = 1; count <= 100; count++) {
      if (freemem() < 384 * 1024 ** 2) {
        stopReason = 'Physical memory reserve below 384 MiB; no forced paging/OOM';
        break;
      }
      replicas.push(new IncrementalReplica(snapshot));
      if ([1, 5, 10, 25, 50, 75, 100].includes(count)) {
        const current = memory();
        const sample = {
          count,
          heapUsed: current.heapUsed - baseline.heapUsed,
          external: current.external - baseline.external,
          arrayBuffers: current.arrayBuffers - baseline.arrayBuffers,
          rss: current.rss - baseline.rss,
          absoluteRss: current.rss,
          freePhysical: freemem(),
        };
        samples.push(sample);
        console.log(
          `MEMORY ${profile}: ${count} replicas, retained heap ${(sample.heapUsed / 1024 ** 2).toFixed(1)} MiB, process RSS ${(current.rss / 1024 ** 2).toFixed(1)} MiB, free ${(sample.freePhysical / 1024 ** 2).toFixed(1)} MiB`,
        );
      }
    }
    const current = memory(),
      loaded = replicas.length;
    const report = {
      profile,
      encodedBytes: snapshot.length,
      baseline,
      availableAtStart: available,
      totalPhysical: totalmem(),
      loaded,
      stopReason,
      retained: {
        heapUsed: current.heapUsed - baseline.heapUsed,
        external: current.external - baseline.external,
        arrayBuffers: current.arrayBuffers - baseline.arrayBuffers,
        rss: current.rss - baseline.rss,
      },
      samples,
    };
    reports.push(report);
    console.log(JSON.stringify(report, null, 2));
    await writeFile(
      process.argv.includes('--history-only')
        ? '.local/incremental-memory-history.json'
        : '.local/incremental-memory.json',
      JSON.stringify(
        {
          date: new Date().toISOString(),
          scope:
            'Actual simultaneously retained persistent replicas in one isolated process, independent checkpoint copy and full indexes per document. Forced GC. Excludes Hocuspocus live documents, sockets, SQL, and worker-per-room overhead. external includes arrayBuffers; do not add them twice.',
          reports,
        },
        null,
        2,
      ),
    );
  } finally {
    for (const replica of replicas) replica.close();
    replicas.length = 0;
    memory();
  }
}
const rebase = [];
for (const profile of process.argv.includes('--history-only')
  ? []
  : ['content-1M', 'history-1M', 'history-4M']) {
  const snapshot = new Uint8Array(await readFile(`.local/incremental/${profile}.bin`));
  const source = new Y.Doc();
  source.getXmlFragment('prosemirror');
  Y.applyUpdate(source, snapshot);
  const samples = [];
  let bytes = 0,
    businessBytes = 0;
  // Evaluation only: no generation switch, document replacement, or client/export flow.
  for (let i = 0; i < 12; i++) {
    const started = performance.now();
    const validated = decodeDocument(source),
      fresh = new Y.Doc();
    fresh.getXmlFragment('prosemirror').insert(
      0,
      source
        .getXmlFragment('prosemirror')
        .toArray()
        .map((node) => {
          assert(node instanceof Y.XmlElement || node instanceof Y.XmlText);
          return node.clone();
        }),
    );
    const rebuilt = Y.encodeStateAsUpdate(fresh);
    bytes = rebuilt.length;
    businessBytes = Buffer.byteLength(JSON.stringify(validated));
    assert.deepEqual(decodeDocument(fresh), validated);
    if (i >= 2) samples.push(performance.now() - started);
    fresh.destroy();
  }
  const report = {
    profile,
    beforeBytes: snapshot.length,
    businessBytes,
    afterBytes: bytes,
    ratio: snapshot.length / businessBytes,
    iterations: 10,
    warmup: 2,
    milliseconds: distribution(samples),
    samples,
  };
  rebase.push(report);
  console.log('REBASE EVALUATION ' + JSON.stringify(report));
  source.destroy();
  memory();
}
if (rebase.length)
  await writeFile(
    '.local/incremental-rebase.json',
    JSON.stringify(
      {
        date: new Date().toISOString(),
        scope:
          'Benchmark-only validated visible XML reconstruction with new Yjs IDs, encode and equality check. No production reset/generation/export implementation.',
        rebase,
      },
      null,
      2,
    ),
  );
console.log('MEMORY AND REBASE EVALUATION COMPLETE');
