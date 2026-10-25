import { build, stop } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertMeasurementPower, readMeasurementPower } from './measurement-power.mjs';

const id = process.argv[2];
if (!id || !/^[a-z0-9-]+$/.test(id)) throw new Error('Expected diagnostic label');
const directory = `.local/access-profile-${id}`;
await mkdir(directory, { recursive: true });
await build({
  entryPoints: ['apps/collab/src/testing/access-profile.ts'],
  outfile: 'apps/collab/dist/access-profile.mjs',
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['pg'],
});
stop();
for (let series = 1; series <= 3; series++) {
  const power = readMeasurementPower();
  console.log(JSON.stringify({ series, power }));
  assertMeasurementPower(power);
  const run = spawnSync(
    process.execPath,
    ['--env-file=.env', 'apps/collab/dist/access-profile.mjs', `${directory}/${series}.json`],
    {
      stdio: 'inherit',
      windowsHide: true,
      timeout: 120000,
      env: { ...process.env, COLLAB_TEST_MIGRATIONS: resolve('packages/db/drizzle') },
    },
  );
  console.log(`Series ${series}: EXIT_CODE=${run.status}`);
  if (run.error) throw run.error;
  if (run.status !== 0) {
    process.exitCode = run.status ?? 1;
    break;
  }
}
