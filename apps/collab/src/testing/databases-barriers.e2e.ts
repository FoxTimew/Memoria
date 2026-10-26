import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { readDatabaseLimits } from '@memoria/db';

const fixture = await testDatabase({ queryTimeoutMs: 120000 });
const { pool, workspace, user, session, page } = fixture;
const base = randomUUID(),
  row = randomUUID();
try {
  await pool.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
    base,
    workspace,
    page,
  ]);
  await pool.query(
    "INSERT INTO pages(id,workspace_id,kind,position) VALUES($1,$2,'database_row','a0')",
    [row, workspace],
  );
  await pool.query('INSERT INTO database_rows(workspace_id,database_id,page_id) VALUES($1,$2,$3)', [
    workspace,
    base,
    row,
  ]);
  const request = JSON.stringify([
    { key: 'row', userid: user, session, workspace, database: base, page: row },
  ]);
  assert.equal(
    (await pool.query('SELECT * FROM database_resolve_access($1::jsonb)', [request])).rows[0]
      ?.level,
    'edit',
  );
  assert.equal(
    (await pool.query('SELECT * FROM content_resolve_access($1::jsonb)', [request])).rowCount,
    0,
    'legacy page request must not grant row access',
  );
  assert.equal(
    (await pool.query('SELECT * FROM content_effective_access($1)', [workspace])).rowCount,
    1,
    'rows excluded from member × page product',
  );
  const a = await pool.connect(),
    b = await pool.connect();
  try {
    await a.query('BEGIN');
    await a.query('SELECT database_lock_rows($1,ARRAY[$2::uuid])', [workspace, row]);
    await b.query('BEGIN');
    await b.query("SET LOCAL lock_timeout='5s'");
    const pid = (await b.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    let finished = false;
    const mutation = b.query('SELECT database_lock_workspace($1)', [workspace]).then(() => {
      finished = true;
    });
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
            [pid],
          )
        ).rowCount
      )
        break;
      await delay(5);
    }
    assert.equal(finished, false, 'rights mutation must wait on the base latch');
    assert(
      (
        await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [
          pid,
        ])
      ).rowCount,
    );
    await a.query('COMMIT');
    await mutation;
    await b.query('ROLLBACK');
    // Revocation first: the writer waits, then uses a different SQL statement/snapshot.
    await b.query('BEGIN');
    await b.query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [
      session,
    ]);
    await a.query('BEGIN');
    const writerPid = (await a.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const waiting = a.query('SELECT database_lock_rows($1,ARRAY[$2::uuid])', [workspace, row]);
    for (let i = 0; i < 100; i++) {
      if (
        (
          await pool.query(
            "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
            [writerPid],
          )
        ).rowCount
      )
        break;
      await delay(5);
    }
    assert(
      (
        await pool.query("SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'", [
          writerPid,
        ])
      ).rowCount,
      'writer must really wait behind the revocation',
    );
    await b.query('COMMIT');
    await waiting;
    assert.equal(
      (await a.query('SELECT * FROM database_resolve_access($1::jsonb)', [request])).rowCount,
      0,
    );
    await a.query('ROLLBACK');
    await pool.query("UPDATE auth_sessions SET expires_at=now()+interval '1 hour' WHERE id=$1", [
      session,
    ]);
  } finally {
    await a.query('ROLLBACK');
    await b.query('ROLLBACK');
    a.release();
    b.release();
  }
  console.log(
    'PASS database barriers: inherited access, closed legacy scope, bounded materialization, writer/revocation in both orders.',
  );
  if (
    process.env.MEMORIA_MEASURE_DATABASES === 'true' ||
    process.env.MEMORIA_MEASURE_DATABASE_TREE === 'true' ||
    process.env.MEMORIA_PROFILE_DATABASES === 'true'
  ) {
    const { measureDatabaseBarriers } = await import('./databases-load.ts');
    await measureDatabaseBarriers(fixture, readDatabaseLimits());
  }
} finally {
  await fixture.close();
}
