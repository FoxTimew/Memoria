import { build, stop } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
await build({
  entryPoints: ['apps/collab/src/testing/manual-database-cells.ts'],
  outfile: 'apps/collab/dist/manual-database-cells.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['pg'],
});
stop();
const child = spawn(
  process.execPath,
  ['--env-file=.env', 'apps/collab/dist/manual-database-cells.mjs', ...process.argv.slice(2)],
  {
    stdio: 'inherit',
    windowsHide: true,
    env: {
      ...process.env,
      COLLAB_TEST_MIGRATIONS: fileURLToPath(new URL('../packages/db/drizzle/', import.meta.url)),
    },
  },
);
child.on('error', () => {
  console.error('Proof process could not start');
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
