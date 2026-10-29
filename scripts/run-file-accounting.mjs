import { spawnSync } from 'node:child_process';
const args = process.argv.slice(2);
if (args.some((arg) => arg !== '--repair') || args.length > 1)
  throw new Error('Usage: pnpm files:accounting [--repair]');
const build = spawnSync(
  process.execPath,
  ['scripts/build-server.mjs', 'worker', '--file-accounting'],
  { stdio: 'inherit', windowsHide: true },
);
if (build.status !== 0) process.exit(build.status ?? 1);
const run = spawnSync(
  process.execPath,
  ['--env-file=.env', 'apps/worker/dist/file-accounting.mjs', ...args],
  { stdio: 'inherit', windowsHide: true },
);
process.exit(run.status ?? 1);
