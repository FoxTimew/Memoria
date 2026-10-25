import { spawnSync } from 'node:child_process';
const built = spawnSync(
  process.execPath,
  ['scripts/build-server.mjs', 'worker', '--reset-factor'],
  { stdio: 'inherit', windowsHide: true },
);
if (built.status !== 0) process.exit(built.status ?? 1);
const result = spawnSync(
  process.execPath,
  ['--env-file=.env', 'apps/worker/dist/reset-factor.mjs', ...process.argv.slice(2)],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(result.status ?? 1);
