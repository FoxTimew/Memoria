import { execFileSync } from 'node:child_process';
import { platform } from 'node:os';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

export const POWER_REQUIRED_MESSAGE =
  'Mesure refusée : BatteryStatus doit valoir 2. Branche le portable sur secteur, puis relance le contrôle. Si le relevé reste indisponible ou différent de 2, vérifier la sonde avant toute mesure.';

// Strict product policy: neither "fully charged" (3) nor "charging" (6) is an exception.
export function assessMeasurementPower(batteries) {
  const rows = Array.isArray(batteries) ? batteries : batteries == null ? [] : [batteries];
  const allowed = rows.length > 0 && rows.every((row) => row?.BatteryStatus === 2);
  return { batteries: rows, allowed, reason: allowed ? null : 'AC_POWER_NOT_CONFIRMED' };
}

export function readMeasurementPower({
  hostPlatform = platform(),
  query = () =>
    execFileSync(
      'powershell.exe',
      [
        '-NoProfile',
        '-Command',
        '$ErrorActionPreference = "Stop"; Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | ConvertTo-Json -Compress',
      ],
      { encoding: 'utf8', windowsHide: true, timeout: 10000 },
    ),
} = {}) {
  const metadata = { observedAt: new Date().toISOString(), platform: hostPlatform };
  if (hostPlatform !== 'win32')
    return { ...metadata, batteries: [], allowed: false, reason: 'POWER_PROBE_UNSUPPORTED' };
  try {
    return { ...metadata, ...assessMeasurementPower(JSON.parse(query())) };
  } catch {
    return { ...metadata, batteries: [], allowed: false, reason: 'POWER_PROBE_FAILED' };
  }
}

export function assertMeasurementPower(observation) {
  if (!observation.allowed)
    throw Object.assign(new Error(POWER_REQUIRED_MESSAGE), { exitCode: 3, observation });
}

// Read-only preflight; does not load the application, fixtures or benchmark.
if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const observation = readMeasurementPower();
  console.log(JSON.stringify(observation, null, 2));
  try {
    assertMeasurementPower(observation);
  } catch (error) {
    console.error(error.message);
    process.exitCode = error.exitCode;
  }
}
