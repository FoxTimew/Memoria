import { spawn } from 'node:child_process';
import { resolve } from 'node:path';
import { mkdir } from 'node:fs/promises';
import { readMeasurementPower, assertMeasurementPower } from '../../scripts/measurement-power.mjs';
const suite = process.argv[2] ?? 'transport';
await mkdir('.local/isolation', { recursive: true });
if (!['transport', 'files-wire', 'files-mixed', 'recovery', 'capacity', 'cold'].includes(suite))
  throw Error('Unknown isolation suite');
if (['files-mixed', 'capacity', 'cold'].includes(suite)) {
  const power = readMeasurementPower();
  console.log(JSON.stringify({ power }));
  assertMeasurementPower(power);
}
async function run(args, timeout) {
  return await new Promise((yes, no) => {
    const p = spawn(process.execPath, args, {
      windowsHide: true,
      stdio: 'inherit',
      timeout,
      env: { ...process.env, COLLAB_TEST_MIGRATIONS: resolve('packages/db/drizzle') },
    });
    p.once('error', no);
    p.once('exit', (code) => yes(code ?? 1));
  });
}
const built = await run(['proof/7d-isolation/build.mjs', suite], 120000);
process.exitCode =
  built ||
  (await run(
    ['cold', 'capacity'].includes(suite)
      ? ['proof/7d-isolation/measure.mjs', suite]
      : ['--env-file=.env', `apps/collab/dist/proof-isolation-${suite}.mjs`],
    ['files-mixed', 'cold', 'capacity'].includes(suite) ? 1800000 : 240000,
  ));
console.log(`Isolation ${suite}: EXIT_CODE=${process.exitCode}`);
