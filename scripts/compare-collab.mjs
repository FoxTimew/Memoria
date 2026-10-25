import { build, stop } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, platform, release, totalmem } from 'node:os';
import { resolve, relative } from 'node:path';
import { finished } from 'node:stream/promises';

// Immutable application snapshots, one common harness, no compiler during measurements.
const repo = resolve('.');
const args = process.argv.slice(2);
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...argv) => execFileSync('git', argv, { windowsHide: true });
const commits = {
  reference: git('rev-parse', option('--reference') ?? '665a829')
    .toString()
    .trim(),
  candidate: git('rev-parse', option('--candidate') ?? '875c63f')
    .toString()
    .trim(),
};
// Workspace dependencies are resolved from this checkout. Reject any source/version drift.
if (
  git('diff', commits.reference, commits.candidate, '--', 'packages', 'pnpm-lock.yaml').length ||
  git('diff', commits.candidate, '--', 'packages', 'pnpm-lock.yaml').length ||
  git('ls-files', '--others', '--exclude-standard', '--', 'packages').length
)
  throw new Error('Comparison requires identical, unchanged workspace packages and lockfile');
const root = resolve('.local/3d-alternating');
const directory = resolve(
  option('--resume') ?? `${root}/${new Date().toISOString().replaceAll(/[:.]/g, '-')}`,
);
if (relative(root, directory).startsWith('..') || directory === root)
  throw new Error('Results must be inside .local/3d-alternating');
const id = directory.split(/[\\/]/).at(-1);
const bundleRoot = resolve(`apps/collab/dist/comparison/${id}`);
const profiles = {};
for (const name of ['content-1M', 'history-1M']) {
  const bytes = await readFile(`.local/incremental/${name}.bin`);
  profiles[name] = { bytes: bytes.length, sha256: hash(bytes) };
}
const protocolHash = hash(await readFile(import.meta.filename));
const power = () => {
  if (platform() !== 'win32') return { unavailable: 'Windows battery observation only' };
  try {
    return JSON.parse(
      execFileSync(
        'powershell.exe',
        [
          '-NoProfile',
          '-Command',
          'Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress',
        ],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 },
      ),
    );
  } catch {
    return { unavailable: true };
  }
};
let manifest;
const manifestPath = `${directory}/manifest.json`;
const save = () => writeFile(manifestPath, JSON.stringify(manifest, null, 2) + '\n');
if (option('--resume')) {
  manifest = JSON.parse(await readFile(manifestPath, 'utf8'));
  if (
    JSON.stringify(commits) !== JSON.stringify(manifest.commits) ||
    JSON.stringify(profiles) !== JSON.stringify(manifest.profiles) ||
    protocolHash !== manifest.protocolHash ||
    process.version !== manifest.host.node
  )
    throw new Error('Commits, profiles, protocol or Node changed; start a new comparison');
} else {
  await mkdir(directory, { recursive: true });
  manifest = {
    commits,
    profiles,
    protocolHash,
    lockfileHash: hash(await readFile('pnpm-lock.yaml')),
    startedAt: new Date().toISOString(),
    host: {
      platform: platform(),
      release: release(),
      node: process.version,
      cpu: cpus()[0]?.model,
      availableCpus: availableParallelism(),
      totalBytes: totalmem(),
    },
    protocol:
      'Three paired series, order AB / BA / AB for each suite; fresh Node process per suite. Both builds completed before any measurements. Same fixtures, migrations, dependencies and common harness; only validator construction/cleanup differ outside timed regions. No samples discarded.',
    artifacts: {},
    series: [],
  };
  const common = {};
  for (const name of ['warm.e2e.ts', 'cold.e2e.ts', 'database.ts', 'profiles.ts'])
    common[name] = git('show', `${commits.candidate}:apps/collab/src/testing/${name}`).toString();
  common['warm.e2e.ts'] = common['warm.e2e.ts']
    .replace(
      "import { IncrementalValidator } from '../service/incremental-validator.ts';",
      "import { createValidationContext } from './comparison-validator.ts';",
    )
    .replace("import { ValidationPool } from '../service/validation-pool.ts';", '')
    .replace("import { readCollabConfig } from '../service/config.ts';", '')
    .replace(
      'new ValidationPool(readCollabConfig().COLLAB_VALIDATION_WORKERS)',
      'createValidationContext()',
    )
    .replace('new IncrementalValidator(validators)', 'validators.create()');
  if (
    common['warm.e2e.ts'].includes('new IncrementalValidator') ||
    !common['warm.e2e.ts'].includes('validators.create()')
  )
    throw new Error('Unexpected warm harness; review adapter substitutions');
  common['cold.e2e.ts'] = common['cold.e2e.ts'].replace(
    'fresh replica in the shared pool (worker processes can be reused)',
    'fresh replica using the selected version worker lifecycle',
  );
  // Never regenerate a fixture during a comparison: both builds must read identical bytes.
  common['profiles.ts'] = `import { readFile } from 'node:fs/promises';
export async function loadProfile(profile: string) {
  return readFile(\`.local/incremental/\${profile}.bin\`);
}`;
  manifest.harness = Object.fromEntries(
    Object.entries(common).map(([name, source]) => [name, hash(source)]),
  );
  const external = [
    'yjs',
    'pg',
    'ws',
    '@hocuspocus/server',
    '@hocuspocus/provider',
    'better-auth',
    '@nestjs/*',
    'reflect-metadata',
    'rxjs',
  ];
  try {
    for (const [configuration, commit] of Object.entries(commits)) {
      const folder = `${directory}/sources/${configuration}`;
      await mkdir(folder, { recursive: true });
      const archive = git('archive', commit, 'apps/collab');
      execFileSync('tar', ['-xf', '-', '-C', folder], { input: archive, windowsHide: true });
      const testing = `${folder}/apps/collab/src/testing`;
      for (const [name, source] of Object.entries(common))
        await writeFile(`${testing}/${name}`, source);
      const adapter =
        configuration === 'reference'
          ? `import { IncrementalValidator } from '../service/incremental-validator.ts';
export function createValidationContext() { return { create: () => new IncrementalValidator(), close: async () => {} }; }`
          : `import { IncrementalValidator } from '../service/incremental-validator.ts';
import { ValidationPool } from '../service/validation-pool.ts';
import { readCollabConfig } from '../service/config.ts';
export function createValidationContext() {
  const pool = new ValidationPool(readCollabConfig().COLLAB_VALIDATION_WORKERS);
  return { create: () => new IncrementalValidator(pool), close: () => pool.close() };
}`;
      await writeFile(`${testing}/comparison-validator.ts`, adapter);
      manifest.artifacts[configuration] = { archiveHash: hash(archive), adapter, bundles: {} };
      for (const entry of ['incremental-worker', 'warm', 'cold']) {
        const source =
          entry === 'incremental-worker'
            ? `${folder}/apps/collab/src/service/${entry}.ts`
            : `${testing}/${entry}.e2e.ts`;
        const output = `${bundleRoot}/${configuration}/${entry}.mjs`;
        await build({
          entryPoints: [source],
          outfile: output,
          bundle: true,
          platform: 'node',
          target: 'node24',
          format: 'esm',
          tsconfig: resolve('apps/collab/tsconfig.json'),
          external: entry === 'incremental-worker' ? ['yjs'] : external,
          nodePaths: [resolve('apps/collab/node_modules'), resolve('node_modules')],
        });
        manifest.artifacts[configuration].bundles[entry] = {
          path: relative(repo, output),
          sha256: hash(await readFile(output)),
        };
      }
    }
  } finally {
    stop();
  }
  await save();
}
console.log(`Results: ${directory}`);
for (let iteration = 1; iteration <= 3; iteration++) {
  for (const suite of ['warm', 'cold']) {
    for (const configuration of iteration === 2
      ? ['candidate', 'reference']
      : ['reference', 'candidate']) {
      if (
        manifest.series.some(
          (s) =>
            s.iteration === iteration && s.suite === suite && s.configuration === configuration,
        )
      )
        continue;
      for (const artifact of Object.values(manifest.artifacts[configuration].bundles))
        if (hash(await readFile(artifact.path)) !== artifact.sha256)
          throw new Error('Bundle changed');
      for (const [name, profile] of Object.entries(profiles))
        if (hash(await readFile(`.local/incremental/${name}.bin`)) !== profile.sha256)
          throw new Error('Fixture changed');
      const battery = power(),
        freeBytes = freemem();
      if (freeBytes < 3 * 1024 ** 3) {
        manifest.stopped = {
          reason: 'FREE_RAM_BELOW_3_GIB',
          at: new Date().toISOString(),
          configuration,
          suite,
          iteration,
          freeBytes,
        };
        await save();
        console.error(
          `STOP: ${(freeBytes / 1024 ** 3).toFixed(3)} GiB free; ask the developer to close applications, then resume.`,
        );
        process.exit(2);
      }
      delete manifest.stopped;
      const name = `${configuration}-${suite}-${iteration}`;
      const log = createWriteStream(`${directory}/${name}.txt`, { flags: 'wx' });
      const start = Date.now();
      console.log(
        `${name}: ${(freeBytes / 1024 ** 3).toFixed(3)} GiB free; battery ${JSON.stringify(battery)}`,
      );
      const code = await new Promise((resolveCode) => {
        const child = spawn(
          process.execPath,
          ['--env-file=.env', manifest.artifacts[configuration].bundles[suite].path],
          {
            env: { ...process.env, COLLAB_TEST_MIGRATIONS: resolve('packages/db/drizzle') },
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
            timeout: 180000,
          },
        );
        child.stdout.on('data', (chunk) => log.write(chunk));
        child.stderr.on('data', (chunk) => log.write(chunk));
        child.on('error', (error) => log.write(error.message + '\n'));
        child.on('close', (exitCode) => resolveCode(exitCode ?? 1));
      });
      log.end(`\nEXIT_CODE=${code}\n`);
      await finished(log);
      const path = `.local/3a-${suite}-production.json`;
      if ((await stat(path)).mtimeMs < start)
        throw new Error(`No fresh ${name} report; complete log retained`);
      const report = JSON.parse(await readFile(path, 'utf8'));
      await writeFile(`${directory}/${name}.json`, JSON.stringify(report, null, 2) + '\n');
      const row = {
        configuration,
        suite,
        iteration,
        startedAt: new Date(start).toISOString(),
        freeBytes,
        battery,
        endedFreeBytes: freemem(),
        code,
        p95: Object.fromEntries(report.reports.map((r) => [r.profile, r.p95])),
      };
      manifest.series.push(row);
      await save();
      console.log(JSON.stringify(row));
    }
  }
}
const median = (values) => [...values].sort((a, b) => a - b)[1];
const metrics = {},
  failures = [];
for (const suite of ['warm', 'cold'])
  for (const profile of Object.keys(profiles)) {
    const key = `${suite}:${profile}`,
      metric = {};
    const ceiling = suite === 'cold' ? 500 : profile === 'content-1M' ? 50 : 100;
    for (const configuration of Object.keys(commits)) {
      const values = manifest.series
        .filter((s) => s.suite === suite && s.configuration === configuration)
        .map((s) => s.p95[profile]);
      if (values.length !== 3 || values.some((v) => !Number.isFinite(v)))
        throw new Error('Three complete series required');
      metric[configuration] = { values, median: median(values) };
      if (
        suite === 'warm' && profile === 'history-1M'
          ? median(values) > ceiling
          : median(values) >= ceiling
      )
        failures.push(`${configuration} ${key}: median ${median(values)} outside ${ceiling} ms`);
    }
    metric.changePercent = (metric.candidate.median / metric.reference.median - 1) * 100;
    metric.pairedChangePercent = metric.candidate.values.map(
      (value, i) => (value / metric.reference.values[i] - 1) * 100,
    );
    if (metric.changePercent > 10)
      failures.push(`${key}: regression ${metric.changePercent.toFixed(2)}% > 10%`);
    metrics[key] = metric;
  }
const summary = {
  commits,
  profiles,
  protocolHash,
  metrics,
  failures,
  failedSeries: manifest.series
    .filter((s) => s.code !== 0)
    .map((s) => `${s.configuration}-${s.suite}-${s.iteration}`),
};
await writeFile(`${directory}/summary.json`, JSON.stringify(summary, null, 2) + '\n');
console.log(JSON.stringify(summary, null, 2));
process.exitCode = failures.length ? 1 : 0;
