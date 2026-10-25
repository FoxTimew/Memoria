import { spawnSync } from 'node:child_process';
import { readMeasurementPower, assertMeasurementPower } from './measurement-power.mjs';
import { freemem } from 'node:os';
const power = readMeasurementPower();
console.log(JSON.stringify({ power, freeBytes: freemem() }));
assertMeasurementPower(power);
if (freemem() < 3 * 1024 ** 3)
  throw new Error('FREE_RAM_BELOW_3_GIB: libérer la mémoire avant mesure.');
for (const argv of [
  ['scripts/build-server.mjs', 'api', '--shares-e2e'],
  ['--env-file=.env', 'apps/api/dist/shares.e2e.mjs'],
]) {
  const result = spawnSync(process.execPath, argv, {
    stdio: 'inherit',
    windowsHide: true,
    env: { ...process.env, MEMORIA_MEASURE_RIGHTS: 'true' },
  });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status ?? 1);
}
