import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';

const folder = resolve(process.argv[2] ?? '');
const allowed = ['.local/history-profile', 'docs/reviews/evidence/session-7-7a-historique'].some(
  (root) => {
    const r = relative(resolve(root), folder);
    return r !== '' && !r.startsWith('..') && !r.includes(':');
  },
);
if (!allowed) throw new Error('Select one history-profile evidence directory');
const measurement = JSON.parse(await readFile(resolve(folder, 'measurement.json'), 'utf8'));
const median = (values) => [...values].sort((a, b) => a - b)[1];
const series = measurement.reports.flatMap((r) =>
  r.result.results
    .filter((x) => x.summary)
    .map((x) => ({
      ...x.summary,
      completeProcess: r.result.code === 0,
      hygieneValid: r.hygiene.assessment.valid,
      batchSizes: [...new Set(x.phases.map((p) => p.contributions))],
      maxPoolOccupancy: Math.max(0, ...x.poolSamples.map((p) => p.queueAtEnqueue)),
      maxRoomWaiting: Math.max(0, ...x.roomIngress.map((p) => p.waiting)),
      snapshotBytes: x.snapshotBytes,
      clientIds: x.clientIds,
    })),
);
const medians = [];
for (const mode of ['shared', 'isolated'])
  for (const authors of [1, 2]) {
    const rows = series.filter(
      (r) => r.mode === mode && r.authors === authors && r.completeProcess && r.hygieneValid,
    );
    if (rows.length !== 3 || new Set(rows.map((r) => r.series)).size !== 3) continue;
    medians.push({
      mode,
      authors,
      server: median(rows.map((r) => r.server.p95)),
      worker: median(rows.map((r) => r.worker.p95)),
      poolWait: median(rows.map((r) => r.poolWait.p95)),
      ipcAndScheduling: median(rows.map((r) => r.ipcAndScheduling.p95)),
      sql: median(rows.map((r) => r.sql.p95)),
      wire: median(rows.map((r) => r.wire.p95)),
      clientEdit: median(rows.map((r) => r.clientEdit.p95)),
      eventLoop: median(rows.map((r) => r.eventLoopP95Ms)),
      mainThreadCpuMs: median(rows.map((r) => r.mainThreadCpuMs)),
      workerThreadCpuMs: median(rows.map((r) => r.workerThreadCpuMs)),
    });
  }
const profiles = [];
for (const file of (await readdir(folder)).filter((f) => f.endsWith('.cpuprofile.gz')).sort()) {
  const p = JSON.parse(gunzipSync(await readFile(resolve(folder, file)))),
    nodes = new Map(p.nodes.map((n) => [n.id, n])),
    parents = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parents.set(c, n.id);
  const key = (id) => {
    const c = nodes.get(id).callFrame;
    return JSON.stringify([c.functionName, c.url, c.lineNumber, c.columnNumber]);
  };
  const self = new Map(),
    inclusive = new Map();
  for (let i = 0; i < (p.samples?.length ?? 0); i++) {
    let id = p.samples[i];
    const ms = p.timeDeltas[i] / 1000,
      k = key(id);
    self.set(k, (self.get(k) ?? 0) + ms);
    const seen = new Set();
    while (id) {
      const frame = key(id);
      if (!seen.has(frame)) {
        inclusive.set(frame, (inclusive.get(frame) ?? 0) + ms);
        seen.add(frame);
      }
      id = parents.get(id);
    }
  }
  const named = (name) =>
    [...inclusive].filter(([k]) => JSON.parse(k)[0] === name).reduce((n, [, v]) => n + v, 0);
  profiles.push({
    file,
    sampledMs: [...self.values()].reduce((a, b) => a + b, 0),
    stateVectorInclusiveMs: named('getStateVector'),
    decodeDocumentInclusiveMs: named('decodeDocument'),
    topSelf: [...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 20)
      .map(([k, ms]) => ({ frame: JSON.parse(k), ms })),
  });
}
const result = {
  diagnosticOnly: true,
  source:
    'Raw CPU samples weighted by timeDeltas; inclusive stacks overlap and must not be summed. Medians only from three completed, hygiene-valid series per configuration.',
  series,
  medians,
  profiles,
};
await writeFile(resolve(folder, 'analysis.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify({
    completedSeries: measurement.reports.filter((r) => r.result.code === 0).length,
    medians,
    profiles: profiles.length,
  }),
);
