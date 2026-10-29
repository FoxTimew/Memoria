import { build, stop } from 'esbuild';
import { spawn, execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
import { resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { readMeasurementPower, assertMeasurementPower } from './measurement-power.mjs';
const power = readMeasurementPower();
console.log(JSON.stringify({ power }));
assertMeasurementPower(power);
const folder = 'apps/collab/dist/history-profile';
await mkdir(folder, { recursive: true });
const options = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
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
};
await build({
  ...options,
  entryPoints: ['apps/collab/src/service/incremental-worker.ts'],
  outfile: folder + '/incremental-worker.mjs',
});
await build({
  ...options,
  entryPoints: ['apps/collab/src/testing/history-profile.ts'],
  outfile: folder + '/profile.mjs',
});
stop();
const output = resolve('.local/history-profile', new Date().toISOString().replaceAll(/[:.]/g, '-'));
console.log(JSON.stringify({ output }));
await mkdir(output, { recursive: true });
const sources = [
  'apps/collab/src/testing/history-profile.ts',
  'scripts/profile-files-history.mjs',
  'apps/collab/src/service/incremental-replica.ts',
  'apps/collab/src/service/incremental-worker.ts',
  'apps/collab/src/service/validation-pool.ts',
  'apps/collab/src/service/room.ts',
  'apps/collab/src/service/store.ts',
  '.local/incremental/history-1M.bin',
];
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify(
    {
      startedAt: new Date().toISOString(),
      diagnosticOnly: true,
      sourceCommit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      node: process.version,
      cpu: cpus()[0]?.model,
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (path) => [
            path,
            createHash('sha256')
              .update(await readFile(path))
              .digest('hex'),
          ]),
        ),
      ),
      protocol:
        'Three diagnostic pairs AB/BA/AB: shared loop vs two separate client processes; unchanged live server and limits. 110 waves (10 warmup) at one author then 110 at two. CPU sampling is enabled in both configurations. Profiling overhead prevents treating these results as qualification. Preserve all threshold exceedances. No application optimization.',
    },
    null,
    2,
  ) + '\n',
);
const child = spawn(process.execPath, ['--env-file=.env', folder + '/profile.mjs'], {
  windowsHide: true,
  stdio: 'inherit',
  env: {
    ...process.env,
    MEMORIA_HISTORY_OUTPUT: output,
    COLLAB_TEST_MIGRATIONS: resolve('packages/db/drizzle'),
  },
});
child.on('error', (e) => {
  console.error(e);
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
