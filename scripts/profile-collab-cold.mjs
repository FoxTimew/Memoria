import { build, stop } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { mkdir, writeFile, readFile, copyFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';
import { prepareMeasurement, runMeasuredSeries } from './measurement-memory.mjs';

const directory = resolve(
  '.local/7d-cold-profile/' + new Date().toISOString().replaceAll(/[:.]/g, '-'),
);
await mkdir(directory, { recursive: true });
const reports = [];
const sources = {};
for (const file of [
  'apps/collab/src/testing/cold-profile.ts',
  'apps/collab/src/testing/cold.e2e.ts',
  'apps/collab/src/service/room.ts',
  'apps/collab/src/service/store.ts',
  'apps/collab/src/service/incremental-validator.ts',
  'apps/collab/src/service/incremental-worker.ts',
  'apps/collab/src/service/incremental-replica.ts',
  'packages/db/src/file-boundary.ts',
])
  sources[file] = createHash('sha256')
    .update(await readFile(file))
    .digest('hex');
const commit = execFileSync('git', ['rev-parse', 'HEAD'], { windowsHide: true }).toString().trim();
const save = () =>
  writeFile(
    `${directory}/measurement.json`,
    JSON.stringify({ commit, sources, reports }, null, 2) + '\n',
  );
console.log(`Results: ${directory}`);
try {
  await prepareMeasurement('cold-profile-build');
  for (const [input, output] of [
    ['apps/collab/src/service/incremental-worker.ts', 'apps/collab/dist/incremental-worker.mjs'],
    ['apps/collab/src/testing/cold-profile.ts', 'apps/collab/dist/test-cold-profile.e2e.mjs'],
  ])
    await build({
      entryPoints: [input],
      outfile: output,
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
      external: [
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
      ],
    });
  stop();
  for (let series = 1; series <= 3; series++) {
    const preparation = await prepareMeasurement(`cold-profile-${series}`);
    const measured = await runMeasuredSeries(
      `cold-profile-${series}`,
      async () => {
        let output = '';
        const code = await new Promise((accept, reject) => {
          const child = spawn(
            process.execPath,
            ['--env-file=.env', 'apps/collab/dist/test-cold-profile.e2e.mjs'],
            {
              windowsHide: true,
              env: {
                ...process.env,
                COLLAB_MEASURE_HYGIENE: 'true',
                COLLAB_TEST_MIGRATIONS: resolve('packages/db/drizzle'),
              },
              timeout: 180000,
            },
          );
          child.stdout.on('data', (v) => {
            output += v.toString();
          });
          child.stderr.on('data', (v) => {
            output += v.toString();
          });
          child.on('error', reject);
          child.on('exit', accept);
        });
        await writeFile(`${directory}/series-${series}.txt`, output);
        // On failure, retain its log and never label stale output from an earlier
        // process as this series' successful profile.
        if (code !== 0) throw new Error(`Cold profile failed: ${code}; see ${directory}`);
        await copyFile('.local/7d-cold-profile.json', `${directory}/series-${series}.json`);
        await copyFile('.local/3a-cold-production.json', `${directory}/cold-${series}.json`);
        return { code };
      },
      { preparation },
    );
    reports.push({ series, preparation, ...measured });
    await save();
  }
} catch (error) {
  await save();
  console.error(error);
  process.exitCode = 1;
} finally {
  stop();
}
