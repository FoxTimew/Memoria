import { availableParallelism, cpus, freemem, platform, release, totalmem } from 'node:os';
import { createHash } from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
import { createWriteStream, readFileSync } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { finished } from 'node:stream/promises';
import { resolve, relative } from 'node:path';
import { readMeasurementPower, POWER_REQUIRED_MESSAGE } from './measurement-power.mjs';
import { assessRegression } from './measurement-regression.mjs';

const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const label = option('--label') ?? 'measurement';
const capacity = option('--suite') === 'capacity';
const suites = capacity ? ['capacity'] : ['warm', 'cold'];
if (!/^[a-z0-9-]+$/.test(label)) throw new Error('Invalid measurement label');
const root = resolve('.local/3d-series');
const directory = resolve(
  option('--resume') ?? `${root}/${label}-${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
);
if (relative(root, directory).startsWith('..') || directory === root)
  throw new Error('Results must be inside .local/3d-series');
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const source = () => {
  const untracked = execFileSync(
    'git',
    ['ls-files', '--others', '--exclude-standard', '--', 'apps/collab', 'packages', 'scripts'],
    { encoding: 'utf8', windowsHide: true },
  )
    .trim()
    .split(/\r?\n/)
    .filter(Boolean);
  return {
    commit: execFileSync('git', ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
      windowsHide: true,
    }).trim(),
    diff: hash(
      execFileSync('git', ['diff', 'HEAD', '--', 'apps/collab', 'packages', 'scripts'], {
        windowsHide: true,
      }),
    ),
    untracked: Object.fromEntries(untracked.map((name) => [name, hash(readFileSync(name))])),
  };
};
const profiles = {};
for (const name of ['content-1M', 'history-1M']) {
  const bytes = await readFile(`.local/incremental/${name}.bin`);
  profiles[name] = { bytes: bytes.length, sha256: hash(bytes) };
}
const fingerprint = source();
const manifestPath = `${directory}/manifest.json`;
let manifest;
if (option('--resume')) {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    JSON.stringify(manifest.source) !== JSON.stringify(fingerprint) ||
    JSON.stringify(manifest.profiles) !== JSON.stringify(profiles)
  )
    throw new Error('Source or fixtures changed; start a new configuration');
} else {
  await mkdir(directory, { recursive: true });
  manifest = {
    label,
    source: fingerprint,
    profiles,
    startedAt: new Date().toISOString(),
    host: {
      platform: platform(),
      release: release(),
      node: process.version,
      cpu: cpus()[0]?.model,
      availableCpus: availableParallelism(),
      totalBytes: totalmem(),
    },
    series: [],
  };
}
const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
await save();
console.log(`Results: ${directory}`);
for (let iteration = 1; iteration <= 3; iteration++) {
  for (const suite of suites) {
    if (manifest.series.some((s) => s.iteration === iteration && s.suite === suite)) continue;
    if (JSON.stringify(source()) !== JSON.stringify(fingerprint))
      throw new Error('Source changed during measurement');
    const battery = readMeasurementPower();
    console.log(`Power: ${JSON.stringify(battery)}`);
    if (!battery.allowed) {
      manifest.stopped = { reason: battery.reason, suite, iteration, battery };
      await save();
      console.error(POWER_REQUIRED_MESSAGE);
      process.exit(3);
    }
    const freeBytes = freemem();
    if (freeBytes < 3 * 1024 ** 3) {
      manifest.stopped = {
        reason: 'FREE_RAM_BELOW_3_GIB',
        at: new Date().toISOString(),
        suite,
        iteration,
        freeBytes,
        battery,
      };
      await save();
      console.error(
        `STOP: ${(freeBytes / 1024 ** 3).toFixed(3)} GiB free; 3 GiB required. Ask the developer to close applications, then resume this directory.`,
      );
      process.exit(2);
    }
    delete manifest.stopped;
    const start = Date.now(),
      log = createWriteStream(`${directory}/${suite}-${iteration}.txt`, { flags: 'wx' });
    console.log(`${suite} ${iteration}/3: ${(freeBytes / 1024 ** 3).toFixed(3)} GiB free`);
    const code = await new Promise((resolveCode) => {
      const child = spawn(process.execPath, ['scripts/test-collab.mjs', '--suite', suite], {
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      child.stdout.on('data', (chunk) => log.write(chunk));
      child.stderr.on('data', (chunk) => log.write(chunk));
      child.on('error', (error) => {
        log.write(error.message + '\n');
      });
      child.on('close', (exitCode) => resolveCode(exitCode ?? 1));
    });
    log.end(`\nEXIT_CODE=${code}\n`);
    await finished(log);
    if (code === 3) {
      manifest.stopped = {
        reason: 'CHILD_POWER_PREFLIGHT_REFUSED',
        suite,
        iteration,
        battery,
        log: `${suite}-${iteration}.txt`,
      };
      await save();
      console.error(
        'Alimentation refusée après compilation. Journal conservé ; démarrer une nouvelle campagne après contrôle du secteur.',
      );
      process.exit(3);
    }
    const path = `.local/${capacity ? '3d' : '3a'}-${suite}-production.json`;
    if ((await stat(path)).mtimeMs < start)
      throw new Error(`No fresh ${suite} report; complete log retained`);
    const report = JSON.parse(await readFile(path, 'utf8'));
    await writeFile(
      `${directory}/${suite}-${iteration}.json`,
      JSON.stringify(report, null, 2) + '\n',
    );
    const row = {
      iteration,
      suite,
      startedAt: new Date(start).toISOString(),
      freeBytes,
      battery,
      endedFreeBytes: freemem(),
      code,
      p95: Object.fromEntries(report.reports.map((r) => [r.profile, capacity ? r.peakRss : r.p95])),
    };
    manifest.series.push(row);
    await save();
    console.log(JSON.stringify(row));
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[1];
const metrics = {};
for (const suite of suites)
  for (const profile of capacity ? ['content-200K', 'history-200K'] : Object.keys(profiles)) {
    const values = manifest.series.filter((s) => s.suite === suite).map((s) => s.p95[profile]);
    if (values.length !== 3 || values.some((v) => !Number.isFinite(v)))
      throw new Error('Three complete series required');
    metrics[`${suite}:${profile}`] = { values, median: median(values) };
  }
const failures = [];
for (const [key, metric] of Object.entries(metrics)) {
  if (capacity) continue; // Capacity assertions (30 sockets, budget, writes, projection) live in the suite.
  const ceiling = key === 'warm:content-1M' ? 50 : key === 'warm:history-1M' ? 100 : 500;
  if (key === 'warm:history-1M' ? metric.median > ceiling : metric.median >= ceiling)
    failures.push(`${key}: median ${metric.median} outside ${ceiling} ms`);
}
let baseline;
if (option('--baseline')) {
  baseline = JSON.parse(await readFile(option('--baseline'), 'utf8'));
  if (JSON.stringify(baseline.profiles) !== JSON.stringify(profiles))
    throw new Error('Baseline fixtures differ');
  for (const [key, metric] of Object.entries(metrics)) {
    const previous = baseline.metrics[key]?.median;
    if (!Number.isFinite(previous)) throw new Error(`Missing baseline ${key}`);
    metric.baseline = previous;
    Object.assign(metric, assessRegression(previous, metric.median));
    if (metric.exceedsRegression)
      failures.push(
        `${key}: regression ${metric.changeMs.toFixed(3)} ms > allowance ${metric.allowedRegressionMs.toFixed(3)} ms (max of 10% or 2 ms)`,
      );
  }
}
const summary = {
  source: fingerprint,
  profiles,
  metrics,
  failures,
  failedSeries: manifest.series.filter((s) => s.code !== 0).map((s) => `${s.suite}-${s.iteration}`),
  scope: capacity
    ? 'Three independent capacity series. Values are sampled peak RSS in bytes, not latency p95. Full per-profile metrics, assertions and complete logs retained.'
    : 'Three independent series per configuration; every p95 and complete log retained. Per-series assertions remain visible; acceptance uses medians and the supplied baseline.',
};
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = failures.length || (capacity && summary.failedSeries.length) ? 1 : 0;
