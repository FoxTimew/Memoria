import { readFile, readdir, writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
import { gunzipSync } from 'node:zlib';
const folder = resolve(process.argv[2] ?? '');
const rel = relative(resolve('.local/mixed-profile'), folder);
if (!rel || rel.startsWith('..') || rel.includes(':'))
  throw Error('Select a mixed-profile directory');
const data = JSON.parse(await readFile(resolve(folder, 'measurement.json'), 'utf8'));
const quantile = (a, q) =>
  a.length ? [...a].sort((a, b) => a - b)[Math.ceil(a.length * q) - 1] : null;
const stat = (a) => ({
  n: a.length,
  p50: quantile(a, 0.5),
  p95: quantile(a, 0.95),
  max: a.length ? Math.max(...a) : null,
});
const series = [];
for (const run of data.reports) {
  const r = run.result.results[0];
  if (!r?.diagnostic?.jobs) {
    series.push({ series: run.series, code: run.result.code, incomplete: true });
    continue;
  }
  const d = r.diagnostic,
    byReceipt = new Map(r.samples.map((s) => [s.receipt, s]));
  const preparations = d.jobs.filter(
    (j) => j.operation === 'prepare' && j.receipts?.some((k) => byReceipt.has(k)),
  );
  const pages = r.perPage.map((p) => {
    const jobs = preparations.filter((j) => byReceipt.get(j.receipts[0])?.pageIndex === p.index);
    return {
      page: p.index,
      p95: p.p95,
      workerIds: [...new Set(jobs.map((j) => j.worker))],
      worker: stat(jobs.map((j) => j.workerMs)),
      poolWait: stat(jobs.map((j) => j.waitMs)),
      ipcAndScheduling: stat(jobs.map((j) => j.outsideWorkerMs)),
      slow: jobs
        .filter((j) => j.to - j.from > 25)
        .map((j) => ({
          id: j.id,
          worker: j.worker,
          workerMs: j.workerMs,
          waitMs: j.waitMs,
          outsideWorkerMs: j.outsideWorkerMs,
          activeAtEnqueue: j.activeAtEnqueue,
          queued: j.queued,
        })),
    };
  });
  const sqlByTag = new Map();
  for (const q of d.queries) {
    const list = sqlByTag.get(q.tag) ?? [];
    list.push(q.to - q.from);
    sqlByTag.set(q.tag, list);
  }
  const rows = d.sql.samples.flatMap((s) => s.rows ?? []),
    waits = {};
  for (const r of rows) {
    const key = r.state + ':' + r.wait_event_type + ':' + r.wait_event;
    waits[key] = (waits[key] ?? 0) + 1;
  }
  series.push({
    series: run.series,
    code: run.result.code,
    hygiene: run.hygiene.assessment,
    pages,
    eventLoopP95Ms: d.eventLoopP95Ms,
    eventLoopMaxMs: d.eventLoopMaxMs,
    mainThreadCpuMs: d.mainThreadCpuMs,
    workers: d.workers,
    backgroundJobs: d.jobs.filter((j) =>
      ['init', 'init-start', 'init-chunk', 'init-finish', 'inspect', 'snapshot'].includes(
        j.operation,
      ),
    ),
    sql: {
      observations: d.sql.samples.length,
      waits,
      blocked: rows.filter((r) => r.blockers?.length),
      statements: [...sqlByTag]
        .map(([tag, values]) => ({ tag, ...stat(values) }))
        .sort((a, b) => b.p95 - a.p95)
        .slice(0, 20),
    },
  });
}
const profiles = [];
for (const file of (await readdir(folder)).filter((p) => p.endsWith('.cpuprofile.gz'))) {
  const p = JSON.parse(gunzipSync(await readFile(resolve(folder, file))));
  const nodes = new Map(p.nodes.map((n) => [n.id, n])),
    parents = new Map();
  for (const n of p.nodes) for (const c of n.children ?? []) parents.set(c, n.id);
  const self = new Map(),
    inclusive = new Map();
  for (let i = 0; i < (p.samples?.length ?? 0); i++) {
    let id = p.samples[i];
    const ms = (p.timeDeltas?.[i] ?? 0) / 1000;
    const name = nodes.get(id).callFrame.functionName;
    self.set(name, (self.get(name) ?? 0) + ms);
    const seen = new Set();
    while (id) {
      const name = nodes.get(id).callFrame.functionName;
      if (!seen.has(name)) {
        inclusive.set(name, (inclusive.get(name) ?? 0) + ms);
        seen.add(name);
      }
      id = parents.get(id);
    }
  }
  profiles.push({
    file,
    topSelf: [...self].sort((a, b) => b[1] - a[1]).slice(0, 20),
    topInclusive: [...inclusive].sort((a, b) => b[1] - a[1]).slice(0, 25),
  });
}
const result = {
  diagnosticOnly: true,
  warning:
    'CPU sampling and SQL observation perturb timing. Inclusive CPU stacks overlap. SQL callback time includes Node scheduling; absence of sampled locks does not prove absence of every short wait.',
  series,
  profiles,
};
await writeFile(resolve(folder, 'analysis.json'), JSON.stringify(result, null, 2) + '\n');
console.log(
  JSON.stringify(
    series.map((s) => ({
      series: s.series,
      code: s.code,
      eventLoop: s.eventLoopP95Ms,
      pages: s.pages?.map((p) => ({
        page: p.page,
        worker: p.worker,
        poolWait: p.poolWait,
        ipc: p.ipcAndScheduling,
      })),
      sqlWaits: s.sql?.waits,
    })),
    null,
    2,
  ),
);
