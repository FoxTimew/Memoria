import { build, stop } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { mkdir, readFile, writeFile, stat } from 'node:fs/promises';
import { availableParallelism, cpus, freemem, platform, release, totalmem } from 'node:os';
import { resolve, relative } from 'node:path';
import { finished } from 'node:stream/promises';
import { prepareMeasurement, runMeasuredSeries } from './measurement-memory.mjs';
import { assessRegression } from './measurement-regression.mjs';

// Immutable application snapshots, one common harness, no compiler during measurements.
const repo = resolve('.');
const args = process.argv.slice(2);
const session6 = args.includes('--session6');
const session5 = args.includes('--session5') || session6;
const session4 = args.includes('--session4') || session5;
const option = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : undefined);
const hash = (bytes) => createHash('sha256').update(bytes).digest('hex');
const git = (...argv) =>
  execFileSync('git', argv, { windowsHide: true, maxBuffer: 128 * 1024 ** 2 });
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
  !session4 &&
  (git('diff', commits.reference, commits.candidate, '--', 'packages', 'pnpm-lock.yaml').length ||
    git('diff', commits.candidate, '--', 'packages', 'pnpm-lock.yaml').length ||
    git('ls-files', '--others', '--exclude-standard', '--', 'packages').length)
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
const protocolHash = hash(
  Buffer.concat([
    await readFile(import.meta.filename),
    await readFile(new URL('./measurement-power.mjs', import.meta.url)),
    await readFile(new URL('./measurement-memory.mjs', import.meta.url)),
    await readFile(new URL('./measurement-regression.mjs', import.meta.url)),
  ]),
);
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
    protocol: session6
      ? 'Session 6: AB / BA / AB, three paired series; immutable application/packages/migrations from each commit; same assurance, mandatory workspace policy AND per-page epoch in BOTH versions. Shared warm/cold harness, memory checks after profile preparation, WSL vmstat over entire child lifetime. Before preparation Windows >=3 GiB; after preparation Windows >=1.5 GiB and WSL MemAvailable >=2 GiB; AC required. Swap-invalidated process is replayed from scratch, no discarded samples hidden.'
      : session5
        ? 'Session 5: AB / BA / AB, three paired series; immutable application/packages/migrations from each commit. Live passkey assurance and required workspace policy in BOTH versions; candidate additionally checks the real per-page browser epoch on every append. Same warm/cold harness and dependency versions, no discarded samples.'
        : session4
          ? 'Session 4: AB / BA / AB, three paired series, immutable sources AND workspace packages AND migrations from each commit. Common warm/cold harness, shared workers in both configurations. Candidate fixture has a live passkey assurance and mandatory workspace policy (SQL fixture, crypto outside timed scope). Same encoded profiles and unchanged common dependency versions. No samples discarded.'
          : 'Three paired series, order AB / BA / AB for each suite; fresh Node process per suite. Both builds completed before any measurements. Same fixtures, migrations, dependencies and common harness; only validator construction/cleanup differ outside timed regions. No samples discarded.',
    artifacts: {},
    series: [],
  };
  const common = {};
  for (const name of ['warm.e2e.ts', 'cold.e2e.ts', 'database.ts', 'profiles.ts'])
    common[name] = git('show', `${commits.candidate}:apps/collab/src/testing/${name}`).toString();
  if (session4) {
    const target = '    return {\n      pool,';
    if (!common['database.ts'].includes(target)) throw new Error('Review changed database fixture');
    common['database.ts'] = common['database.ts'].replace(
      target,
      `
    if (process.env.COLLAB_MEASURE_STRONG === 'true') {
      const factor = randomUUID();
      await client.query("INSERT INTO auth_passkeys(id,user_id,public_key,credential_id,counter,device_type,backed_up) VALUES($1,$2,'measurement-only-not-a-real-key',$3,0,'singleDevice',false)", [factor,user,randomUUID()]);
      await client.query("INSERT INTO session_assurance(session_id,method,verified_at,security_version,factor_id) VALUES($1,'passkey',now(),0,$2)", [session,factor]);
      await client.query("INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())", [workspace]);
      const access = await client.query('SELECT auth_session_can_access_workspace($1,$2) AS allowed', [session,workspace]);
      if (access.rows[0]?.allowed !== true) throw new Error('Strong benchmark fixture not authorized');
    }
${target}`,
    );
  }
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
    '@better-auth/passkey',
    '@nestjs/*',
    'reflect-metadata',
    'rxjs',
  ];
  try {
    for (const [configuration, commit] of Object.entries(commits)) {
      const folder = `${directory}/sources/${configuration}`;
      await mkdir(folder, { recursive: true });
      await mkdir(`${folder}/scripts`, { recursive: true });
      for (const name of ['measurement-memory.mjs', 'measurement-power.mjs'])
        await writeFile(`${folder}/scripts/${name}`, await readFile(`scripts/${name}`));
      const archive = git('archive', commit, 'apps/collab', ...(session4 ? ['packages'] : []));
      execFileSync('tar', ['-xf', '-', '-C', folder], { input: archive, windowsHide: true });
      const testing = `${folder}/apps/collab/src/testing`;
      for (const [name, source] of Object.entries(common))
        await writeFile(`${testing}/${name}`, source);
      const adapter =
        configuration === 'reference' && !session4
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
      const exports = new Map(),
        packageFolders = [];
      if (session4) {
        for (const path of git('ls-tree', '-r', '--name-only', commit, 'packages')
          .toString()
          .split(/\r?\n/)
          .filter((p) => p.endsWith('/package.json'))) {
          const metadata = JSON.parse(await readFile(`${folder}/${path}`, 'utf8'));
          const current = JSON.parse(await readFile(path, 'utf8'));
          for (const [name, version] of Object.entries(metadata.dependencies ?? {})) {
            if (current.dependencies?.[name] !== version)
              throw new Error(`Dependency drift: ${path} ${name}`);
          }
          packageFolders.push(resolve(path, '../node_modules'));
          const targets =
            typeof metadata.exports === 'string' ? { '.': metadata.exports } : metadata.exports;
          for (const [subpath, target] of Object.entries(targets ?? {})) {
            if (typeof target !== 'string') throw new Error('Unsupported snapshot export');
            exports.set(
              metadata.name + (subpath === '.' ? '' : subpath.slice(1)),
              resolve(folder, path, '..', target),
            );
          }
        }
        manifest.artifacts[configuration].migrations = relative(
          repo,
          resolve(folder, 'packages/db/drizzle'),
        );
      }
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
          nodePaths: [
            resolve('apps/collab/node_modules'),
            resolve('node_modules'),
            ...packageFolders,
          ],
          plugins: session4
            ? [
                {
                  name: 'immutable-workspace-packages',
                  setup(builder) {
                    builder.onResolve({ filter: /^@memoria\// }, ({ path }) => {
                      if (!exports.has(path)) throw new Error(`Missing snapshot export: ${path}`);
                      return { path: exports.get(path) };
                    });
                  },
                },
              ]
            : [],
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
      const name = `${configuration}-${suite}-${iteration}`;
      const preparation = await prepareMeasurement(name);
      let attempt = 0;
      const {
        result: { code, report, start },
        hygiene,
      } = await runMeasuredSeries(
        name,
        async () => {
          const log = createWriteStream(`${directory}/${name}-attempt-${++attempt}.txt`, {
            flags: 'wx',
          });
          const start = Date.now();
          const code = await new Promise((resolveCode) => {
            const child = spawn(
              process.execPath,
              ['--env-file=.env', manifest.artifacts[configuration].bundles[suite].path],
              {
                env: {
                  ...process.env,
                  COLLAB_TEST_MIGRATIONS: resolve(
                    manifest.artifacts[configuration].migrations ?? 'packages/db/drizzle',
                  ),
                  COLLAB_MEASURE_STRONG: String(
                    session5 || (session4 && configuration === 'candidate'),
                  ),
                  COLLAB_MEASURE_PAGE_EPOCH: String(
                    session6 || (session5 && configuration === 'candidate'),
                  ),
                  COLLAB_MEASURE_HYGIENE: 'true',
                },
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
          if (!report.reports.every((r) => r.memoryAfterPreparation))
            throw new Error(
              'Missing post-preparation memory evidence; use the updated common harness',
            );
          return { code, report, start };
        },
        { preparation },
      );
      await writeFile(`${directory}/${name}.json`, JSON.stringify(report, null, 2) + '\n');
      const row = {
        configuration,
        suite,
        iteration,
        startedAt: new Date(start).toISOString(),
        preparation,
        hygiene,
        freeBytes: hygiene.before.windowsFreeBytes,
        battery: hygiene.before.power,
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
    Object.assign(metric, assessRegression(metric.reference.median, metric.candidate.median));
    metric.pairedChangePercent = metric.candidate.values.map(
      (value, i) => (value / metric.reference.values[i] - 1) * 100,
    );
    if (metric.exceedsRegression)
      failures.push(
        `${key}: regression ${metric.changeMs.toFixed(3)} ms > allowance ${metric.allowedRegressionMs.toFixed(3)} ms (max of 10% or 2 ms)`,
      );
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
