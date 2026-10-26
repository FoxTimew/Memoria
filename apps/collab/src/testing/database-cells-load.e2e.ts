import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { DatabaseFault } from '@memoria/db';
import { cellFixture } from './database-cell-fixture.ts';
import { databaseWssWriters } from './database-wss-writers.ts';
const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]!;
const f = await cellFixture();
const writers = await databaseWssWriters(f.db, f.bases, {
  page: f.rows[0]!,
  database: f.bases[0]!,
});
const versions = ['0', '0'];
const reports: {
  series: number;
  power: unknown;
  freeBytes: number;
  samples: number[][];
  conflicts: number[];
  p95: number[];
  receipts: number;
  wireP95: number;
}[] = [];
try {
  for (let series = 1; series <= 3; series++) {
    const power = JSON.parse(
      execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
    const freeBytes = freemem();
    console.log(JSON.stringify({ series, power, freeBytes }));
    assert(power.allowed, 'AC_POWER_REQUIRED');
    assert(freeBytes >= 3 * 1024 ** 3, 'FREE_RAM_BELOW_3_GIB');
    const samples: number[][] = [[], []],
      conflicts: number[] = [];
    const editor = await writers.run(async () => {
      await Promise.all(
        writers.subjects.map(async (subject, index) => {
          const kind = index ? 'multi_select' : 'text';
          for (let n = 0; n < 100; n++) {
            const started = performance.now();
            const result = await f.cells.write(subject, {
              ...f.address(kind),
              expectedSchemaVersion: '1',
              expectedCellVersion: versions[index]!,
              value: index ? [f.options.multi_select![n % 2]] : `${series}-${n}`,
            });
            JSON.stringify(result);
            versions[index] = result.version;
            samples[index]!.push(performance.now() - started);
            await delay(25);
          }
        }),
      );
      // Genuine conflicts are recorded separately, never mixed with successful commit p95.
      for (let n = 0; n < 30; n++) {
        const expected = versions[0]!,
          start = performance.now();
        const results = await Promise.allSettled(
          writers.subjects.map((subject) =>
            f.cells.write(subject, {
              ...f.address('text'),
              expectedSchemaVersion: '1',
              expectedCellVersion: expected,
              value: 'race',
            }),
          ),
        );
        const success = results.find((r) => r.status === 'fulfilled');
        assert(success?.status === 'fulfilled');
        versions[0] = success.value.version;
        assert(
          results.some(
            (r) =>
              r.status === 'rejected' &&
              r.reason instanceof DatabaseFault &&
              r.reason.code === 'CELL_VERSION_CONFLICT',
          ),
        );
        conflicts.push(performance.now() - start);
      }
      await delay(1000);
    });
    await writers.assertConverged();
    const values = samples.map(p95);
    reports.push({
      series,
      power,
      freeBytes,
      samples,
      conflicts,
      p95: values,
      receipts: editor.roundTrips.length,
      wireP95: p95(editor.roundTrips),
    });
    await writeFile(
      '.local/session-6a-cell-measurement.json',
      JSON.stringify(
        {
          protocol:
            'Two distinct real sessions; two Yjs clients share one row; 100 scalar and 100 set commits, 30 conflicting pairs per series; kernel entry through serialization, without future HTTP adapter',
          reports,
        },
        null,
        2,
      ) + '\n',
    );
    console.log(
      JSON.stringify({
        series,
        p95: values,
        conflictPairP95: p95(conflicts),
        wireP95: p95(editor.roundTrips),
        receipts: editor.roundTrips.length,
      }),
    );
  }
  const medians = [0, 1].map((i) => reports.map((r) => r.p95[i]!).sort((a, b) => a - b)[1]!);
  console.log(JSON.stringify({ medians, limit: 100, passed: medians.every((v) => v < 100) }));
  assert(
    medians.every((v) => v < 100),
    'STOP_6A_CELL_BUDGET',
  );
} finally {
  await writers.close();
  await f.db.close();
}
