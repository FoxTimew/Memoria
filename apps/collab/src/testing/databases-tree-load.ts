import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestDatabase } from './database.ts';
import { databaseWssWriters } from './database-wss-writers.ts';

const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1] ?? 0;
const median = (v: number[]) => [...v].sort((a, b) => a - b)[1]!;

export async function measureDatabaseTree(
  db: TestDatabase,
  bases: string[],
  tree: {
    root: string;
    parent: string;
    destination: string;
    descendants: number;
  },
) {
  const writers = await databaseWssWriters(db, bases);
  const reports: {
    kind: string;
    series: number;
    freeBytes: number;
    power: unknown;
    mutations: number[];
    waits: number[];
    confirmations: number[];
    roundTrips: number[];
    p95: number[];
  }[] = [];
  const path = '.local/session-6a-tree-measurement.json';
  const save = () =>
    writeFile(
      path,
      JSON.stringify(
        {
          fixture: {
            pages: 1000,
            bases: 50,
            rows: 50000,
            members: 100,
            grants: 5000,
            subtree: tree.descendants,
          },
          protocol:
            '32 isolated mutation windows per case/series, 2 warmups; real commit then 200 ms writing; inverse cleanup outside writer windows',
          transport: writers.metadata,
          reports,
        },
        null,
        2,
      ) + '\n',
    );
  const reset = () =>
    db.pool.query('UPDATE pages SET parent_id=$1,deleted_at=NULL WHERE id=$2', [
      tree.parent,
      tree.root,
    ]);
  try {
    for (const kind of ['move', 'archive', 'restore']) {
      for (let series = 1; series <= 3; series++) {
        const power = JSON.parse(
          execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        );
        const freeBytes = freemem();
        console.log(JSON.stringify({ kind, series, power, freeBytes }));
        assert(power.allowed, 'AC_POWER_REQUIRED');
        assert(freeBytes >= 3 * 1024 ** 3, 'FREE_RAM_BELOW_3_GIB');
        const mutations: number[] = [],
          waits: number[] = [],
          confirmations: number[] = [],
          roundTrips: number[] = [];
        for (let i = 0; i < 32; i++) {
          await reset();
          if (kind === 'restore')
            await db.pool.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [tree.root]);
          let elapsed = 0;
          const editors = await writers.run(async () => {
            const start = performance.now();
            if (kind === 'move')
              await db.pool.query('UPDATE pages SET parent_id=$1 WHERE id=$2', [
                tree.destination,
                tree.root,
              ]);
            else
              await db.pool.query(
                `UPDATE pages SET deleted_at=${kind === 'archive' ? 'now()' : 'NULL'} WHERE id=$1`,
                [tree.root],
              );
            elapsed = performance.now() - start;
            await delay(200);
          }, 1);
          if (i >= 2) {
            mutations.push(elapsed);
            waits.push(...editors.allWaits);
            confirmations.push(...editors.confirmations);
            roundTrips.push(...editors.roundTrips);
          }
        }
        assert(roundTrips.length >= 30);
        const values = [p95(mutations), p95(waits), p95(confirmations), p95(roundTrips)];
        reports.push({
          kind,
          series,
          freeBytes,
          power,
          mutations,
          waits,
          confirmations,
          roundTrips,
          p95: values,
        });
        await save();
        console.log(
          JSON.stringify({
            kind,
            series,
            p95: values,
            mutations: mutations.length,
            receipts: roundTrips.length,
          }),
        );
      }
    }
    let passed = true;
    for (const kind of ['move', 'archive', 'restore']) {
      const rows = reports.filter((r) => r.kind === kind);
      const values = [0, 1, 2, 3].map((i) => median(rows.map((r) => r.p95[i]!)));
      const ok = values.every((v, i) => v < [500, 100, 200, 200][i]!);
      passed &&= ok;
      console.log(
        JSON.stringify({ kind, medianP95: values, limits: [500, 100, 200, 200], passed: ok }),
      );
    }
    assert(passed, 'STOP_6A_TREE_BUDGET');
  } finally {
    await writers.close();
  }
}
