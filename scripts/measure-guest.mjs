import { spawnSync } from 'node:child_process';
import { freemem } from 'node:os';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { readMeasurementPower, assertMeasurementPower } from './measurement-power.mjs';
const directory = '.local/session-5d-guest';
mkdirSync(directory, { recursive: true });
const reports = [];
for (let series = 1; series <= 3; series++)
  for (const depth of [5, 50]) {
    const power = readMeasurementPower(),
      freeBytes = freemem();
    console.log(JSON.stringify({ series, depth, power, freeBytes }));
    assertMeasurementPower(power);
    if (freeBytes < 3 * 1024 ** 3)
      throw new Error('FREE_RAM_BELOW_3_GIB: libérer la mémoire avant mesure');
    const result = spawnSync(process.execPath, ['scripts/test-collab.mjs', '--suite', 'warm'], {
      windowsHide: true,
      encoding: 'utf8',
      maxBuffer: 16 * 1024 ** 2,
      env: { ...process.env, COLLAB_MEASURE_GUEST_DEPTH: String(depth) },
    });
    writeFileSync(
      `${directory}/depth-${depth}-${series}.txt`,
      result.stdout + result.stderr + `\nEXIT_CODE=${result.status}\n`,
    );
    if (result.error) throw result.error;
    if (result.status !== 0) process.exit(result.status ?? 1);
    const report = JSON.parse(readFileSync('.local/3a-warm-production.json', 'utf8'));
    reports.push({ series, depth, power, freeBytes, ...report });
    writeFileSync(`${directory}/reports.json`, JSON.stringify(reports, null, 2) + '\n');
    console.log(
      JSON.stringify({ series, depth, p95: report.reports.map((r) => [r.profile, r.p95]) }),
    );
  }
