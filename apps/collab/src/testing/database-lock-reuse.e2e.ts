import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from '@memoria/db';
import { testDatabase } from './database.ts';

await test('workspace barrier reuse follows real PostgreSQL transactions and savepoints', async (t) => {
  const f = await testDatabase();
  const a = await f.pool.connect(),
    b = await f.pool.connect();
  const base = randomUUID(),
    row = randomUUID(),
    other = randomUUID(),
    otherPage = randomUUID();
  const lock = (c: PoolClient, workspace = f.workspace) =>
    c.query('SELECT database_lock_workspace($1)', [workspace]);
  const markers = async (c: PoolClient) =>
    Number((await c.query('SELECT count(*) n FROM pg_temp.memoria_database_barriers')).rows[0].n);
  async function blocked(
    c: PoolClient,
    sql: string,
    values: unknown[],
    release: () => Promise<unknown>,
  ) {
    const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    let done = false;
    const pending = c.query(sql, values).finally(() => {
      done = true;
    });
    // Observe lock contention, not a fixed sleep standing in for contention.
    void pending.catch(() => {});
    try {
      let waiting = false;
      for (let n = 0; n < 200 && !done; n++) {
        waiting = Boolean(
          (
            await f.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0",
              [pid],
            )
          ).rowCount,
        );
        if (waiting) break;
        await delay(5);
      }
      assert(waiting, 'the real SQL request must wait behind the held lock');
      assert.equal(done, false);
    } finally {
      await release();
    }
    await pending;
  }
  try {
    await f.pool.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
      base,
      f.workspace,
      f.page,
    ]);
    await f.pool.query(
      "INSERT INTO pages(id,workspace_id,kind,position) VALUES($1,$2,'database_row','a0')",
      [row, f.workspace],
    );
    await f.pool.query(
      'INSERT INTO database_rows(workspace_id,database_id,page_id) VALUES($1,$2,$3)',
      [f.workspace, base, row],
    );
    await f.pool.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Other',$2)", [
      other,
      other,
    ]);
    await f.pool.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'a0')", [
      otherPage,
      other,
    ]);
    await a.query("SET lock_timeout='5s'");
    await b.query("SET lock_timeout='5s'");

    await t.test(
      'repeated acquisition retains row and ordinary-page barriers until commit or rollback',
      async () => {
        for (const [target, end] of [
          [row, 'COMMIT'],
          [f.page, 'ROLLBACK'],
        ] as const) {
          await a.query('BEGIN');
          for (let n = 0; n < 103; n++) await lock(a);
          assert.equal(await markers(a), 1);
          await b.query('BEGIN');
          await blocked(b, 'SELECT content_lock_document($1,$2)', [f.workspace, target], () =>
            a.query(end),
          );
          await b.query('ROLLBACK');
        }
      },
    );
    await t.test(
      'same connection reacquires after commit and rollback, behind a cell writer',
      async () => {
        for (const end of ['COMMIT', 'ROLLBACK']) {
          await a.query('BEGIN');
          await lock(a);
          await a.query(end);
          assert.equal(await markers(a), 0);
          await b.query('BEGIN');
          await b.query('SELECT database_lock_rows($1,ARRAY[$2::uuid])', [f.workspace, row]);
          await a.query('BEGIN');
          await blocked(a, 'SELECT database_lock_workspace($1)', [f.workspace], () =>
            b.query('COMMIT'),
          );
          assert.equal(await markers(a), 1);
          await a.query('ROLLBACK');
        }
      },
    );
    await t.test(
      'rollback to acquisition savepoint removes marker and locks, requiring reacquisition',
      async () => {
        await a.query('BEGIN');
        await a.query('SAVEPOINT before_lock');
        await lock(a);
        await a.query('ROLLBACK TO before_lock');
        assert.equal(await markers(a), 0);
        await b.query('BEGIN');
        await b.query('SELECT database_lock_rows($1,ARRAY[$2::uuid])', [f.workspace, row]);
        await blocked(a, 'SELECT database_lock_workspace($1)', [f.workspace], () =>
          b.query('ROLLBACK'),
        );
        await a.query('ROLLBACK');
      },
    );
    await t.test(
      'outer acquisition survives an inner rollback and still blocks writers',
      async () => {
        await a.query('BEGIN');
        await lock(a);
        await a.query('SAVEPOINT inner_work');
        await lock(a);
        await a.query('ROLLBACK TO inner_work');
        assert.equal(await markers(a), 1);
        await b.query('BEGIN');
        await blocked(b, 'SELECT content_lock_document($1,$2)', [f.workspace, row], () =>
          a.query('COMMIT'),
        );
        await b.query('ROLLBACK');
      },
    );
    await t.test(
      'failed partial acquisition creates no marker after exception rollback',
      async () => {
        await b.query('BEGIN');
        await b.query('SELECT database_lock_rows($1,ARRAY[$2::uuid])', [f.workspace, row]);
        await a.query('BEGIN');
        await a.query('SAVEPOINT before_timeout');
        await a.query("SET LOCAL lock_timeout='40ms'");
        await assert.rejects(lock(a), { code: '55P03' });
        await a.query('ROLLBACK TO before_timeout');
        assert.equal(await markers(a), 0);
        await blocked(a, 'SELECT database_lock_workspace($1)', [f.workspace], () =>
          b.query('COMMIT'),
        );
        await a.query('ROLLBACK');
      },
    );
    await t.test(
      'markers are per workspace and acquisition of another workspace cannot be skipped',
      async () => {
        await a.query('BEGIN');
        await lock(a);
        await b.query('BEGIN');
        await b.query('SELECT content_lock_document($1,$2)', [other, otherPage]);
        await blocked(a, 'SELECT database_lock_workspace($1)', [other], () => b.query('ROLLBACK'));
        assert.equal(await markers(a), 2);
        await a.query('COMMIT');
      },
    );
    await t.test(
      'first-use temporary DDL rolls back with its savepoint and can be recreated',
      async () => {
        // A separate physical connection with no previous temporary table.
        const c = await f.pool.connect();
        try {
          await c.query('DROP TABLE IF EXISTS pg_temp.memoria_database_barriers');
          await c.query('BEGIN');
          await c.query('SAVEPOINT fresh');
          await lock(c);
          await c.query('ROLLBACK TO fresh');
          assert.equal(
            (await c.query("SELECT to_regclass('pg_temp.memoria_database_barriers') r")).rows[0].r,
            null,
          );
          await lock(c);
          assert.equal(await markers(c), 1);
          await c.query('COMMIT');
          assert.equal(await markers(c), 0);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      },
    );
    await t.test(
      'a container and page inserted after acquisition remain protected by their creating transaction',
      async () => {
        const p = randomUUID(),
          d = randomUUID();
        await a.query('BEGIN');
        await lock(a);
        await a.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'a1')", [
          p,
          f.workspace,
        ]);
        await a.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
          d,
          f.workspace,
          p,
        ]);
        await lock(a);
        assert.equal((await b.query('SELECT id FROM pages WHERE id=$1', [p])).rowCount, 0);
        await b.query('BEGIN');
        await blocked(b, 'SELECT database_lock_workspace($1)', [f.workspace], () =>
          a.query('COMMIT'),
        );
        assert.equal((await b.query('SELECT id FROM databases WHERE id=$1', [d])).rowCount, 1);
        await b.query('ROLLBACK');
      },
    );
  } finally {
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
    a.release();
    b.release();
    await f.close();
  }
});
