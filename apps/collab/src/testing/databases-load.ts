import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { databaseLoadFixture } from './databases-fixture.ts';
import type { DatabaseLimits } from '@memoria/db';
import type { TestDatabase } from './database.ts';
import { databaseWriters } from './database-writers.ts';
import { databaseWssWriters } from './database-wss-writers.ts';

/** First blocking gate: real SQL mutation cost. HTTP and editor waiting can only add to it. */
export async function measureDatabaseBarriers(fixture: TestDatabase, limits: DatabaseLimits) {
  const { pool } = fixture;
  const { bases, targetUsers, tree } = await databaseLoadFixture(fixture, limits);
  if (process.env.MEMORIA_MEASURE_DATABASE_TREE === 'true') {
    const { measureDatabaseTree } = await import('./databases-tree-load.ts');
    await measureDatabaseTree(fixture, bases, tree);
    return;
  }
  if (process.env.MEMORIA_PROFILE_DATABASES === 'true') {
    const { profileDatabaseMutation } = await import('./databases-profile.ts');
    await profileDatabaseMutation(fixture, targetUsers[0]!);
    return;
  }
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
  const reports: {
    series: number;
    freeBytes: number;
    power: unknown;
    samples: number[];
    p95: number;
    waitP95: number;
    confirmationP95: number;
    editors: Awaited<ReturnType<Awaited<ReturnType<typeof databaseWriters>>['run']>> & {
      roundTrips?: number[];
    };
    wireP95?: number;
  }[] = [];
  await mkdir('.local', { recursive: true });
  const wire = process.env.MEMORIA_DATABASE_WSS === 'true';
  const writers = wire
    ? await databaseWssWriters(fixture, bases)
    : await databaseWriters(fixture, bases);
  try {
    if (process.env.MEMORIA_DATABASE_WSS_SMOKE === 'true') {
      await writers.run(() => new Promise((resolve) => setTimeout(resolve, 2500)));
      console.log(
        'PASS WSS smoke: four real clients, verified Caddy TLS, matching durable receipts.',
      );
      return;
    }
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
      const samples: number[] = [];
      // Includes deferred access reconciliation and durable commit. No simulated mutex.
      const editors: {
        confirmations: number[];
        waits: number[];
        allWaits: number[];
        roundTrips?: number[];
      } = await writers.run(async () => {
        const started = performance.now();
        // Continuous mutation pressure as before, extended to ten seconds for >=30 wire samples.
        for (let i = 0; i < 32 || (wire && performance.now() - started < 10000); i++) {
          const start = performance.now();
          await pool.query('UPDATE workspace_members SET role=$1 WHERE id=$2', [
            i % 2 ? 'member' : 'guest',
            targetUsers[0],
          ]);
          if (i >= 2) samples.push(performance.now() - start);
        }
      });
      const mutationP95 = p95(samples),
        waitP95 = p95(editors.allWaits),
        confirmationP95 = p95(editors.confirmations);
      const wireP95 = editors.roundTrips ? p95(editors.roundTrips) : undefined;
      reports.push({
        series,
        freeBytes,
        power,
        samples,
        p95: mutationP95,
        waitP95,
        confirmationP95,
        editors,
        ...(wireP95 === undefined ? {} : { wireP95 }),
      });
      console.log(
        JSON.stringify({
          series,
          p95: mutationP95,
          waitP95,
          confirmationP95,
          samples: samples.length,
          writes: editors.confirmations.length,
          wireP95,
        }),
      );
      await writeFile(
        wire
          ? '.local/session-6a-optimized-wss-measurement.json'
          : '.local/session-6a-barriers-measurement.json',
        JSON.stringify(
          {
            fixture: { pages: 1000, bases: 50, rows: 50000, members: 100, grants: 5000 },
            transport:
              'metadata' in writers ? writers.metadata : { transport: 'direct Room/Store' },
            reports,
          },
          null,
          2,
        ) + '\n',
      );
    }
    const median = reports.map((r) => r.p95).sort((a, b) => a - b)[1]!;
    const waitMedian = reports.map((r) => r.waitP95).sort((a, b) => a - b)[1]!;
    const confirmationMedian = reports.map((r) => r.confirmationP95).sort((a, b) => a - b)[1]!;
    const wireMedian = wire ? reports.map((r) => r.wireP95!).sort((a, b) => a - b)[1]! : undefined;
    console.log(
      JSON.stringify({
        gate: 'rights_sql_commit_ms',
        medianP95: median,
        limit: 500,
        waitMedian,
        confirmationMedian,
        wireMedian,
        passed:
          median < 500 &&
          waitMedian < 100 &&
          confirmationMedian < 200 &&
          (wireMedian === undefined || wireMedian < 200),
      }),
    );
    assert(
      median < 500,
      'STOP_6A_RIGHTS_BARRIER_BUDGET: SQL cost alone exceeds the 500 ms server target',
    );
    if (wireMedian !== undefined)
      assert(
        wireMedian < 200,
        'STOP_6A_WSS_CONFIRMATION_BUDGET: end-to-end confirmations exceed 200 ms',
      );
    assert(waitMedian < 100, 'STOP_6A_EDITOR_WAIT_BUDGET: observed SQL lock waits exceed 100 ms');
    assert(
      confirmationMedian < 200,
      'STOP_6A_CONFIRMATION_BUDGET: journal confirmations exceed 200 ms',
    );
  } finally {
    await writers.close();
  }
}
