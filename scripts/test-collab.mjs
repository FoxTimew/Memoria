import { build, stop } from 'esbuild';
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { readMeasurementPower, assertMeasurementPower } from './measurement-power.mjs';
const measurementSuites = new Set(['warm.e2e.ts', 'cold.e2e.ts', 'capacity.e2e.ts']);
const powerPreflight = () => {
  const battery = readMeasurementPower();
  console.log(`Power: ${JSON.stringify(battery)}`);
  try {
    assertMeasurementPower(battery);
  } catch (error) {
    console.error(error.message);
    process.exit(error.exitCode);
  }
};
const requested = process.argv[process.argv.indexOf('--suite') + 1];
const files = (await readdir('apps/collab/src/testing'))
  .filter(
    (n) =>
      n.endsWith('.e2e.ts') && (!process.argv.includes('--suite') || n === `${requested}.e2e.ts`),
  )
  .sort();
if (!files.length) throw new Error('No matching integration suite');
if (files.some((file) => measurementSuites.has(file))) powerPreflight();
await build({
  entryPoints: ['apps/collab/src/service/incremental-worker.ts'],
  outfile: 'apps/collab/dist/incremental-worker.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['yjs'],
});
for (const file of files) {
  const out = `apps/collab/dist/test-${file.replace('.ts', '.mjs')}`;
  await build({
    entryPoints: [`apps/collab/src/testing/${file}`],
    outfile: out,
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
  });
  // Release this runner's compiler process before the test/measurement starts.
  stop();
  if (measurementSuites.has(file)) powerPreflight();
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      [...(file === 'capacity.e2e.ts' ? ['--expose-gc'] : []), '--env-file=.env', out],
      {
        env: {
          ...process.env,
          COLLAB_TEST_MIGRATIONS: fileURLToPath(
            new URL('../packages/db/drizzle/', import.meta.url),
          ),
        },
        stdio: 'inherit',
        windowsHide: true,
        timeout: 180000,
      },
    );
    child.on('error', (e) => {
      console.error(e.message);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  console.log(`Collaboration ${file}: EXIT_CODE=${code}`);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
