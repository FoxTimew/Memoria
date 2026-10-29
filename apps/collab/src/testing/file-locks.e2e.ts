import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { testDatabase } from './database.ts';

test('7a diagnostic: projection FK key-share blocks the authoritative file FOR UPDATE latch', async () => {
  const db = await testDatabase(),
    projection = await db.pool.connect(),
    writer = await db.pool.connect(),
    file = randomUUID();
  try {
    await db.pool.query(
      "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$1::uuid::text,'fixture','application/octet-stream',1,'ready')",
      [file, db.workspace],
    );
    await projection.query('BEGIN');
    await writer.query('BEGIN');
    await projection.query(
      'INSERT INTO file_references(workspace_id,page_id,file_id) VALUES($1,$2,$3)',
      [db.workspace, db.page, file],
    );
    const projectionPid = (await projection.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    const writerPid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
    await writer.query("SET LOCAL lock_timeout='1500ms'");
    const pending = writer.query('SELECT id FROM files WHERE id=$1 FOR UPDATE', [file]).then(
      () => null,
      (error) => error as { code: string },
    );
    let blockers: number[] = [];
    for (let i = 0; i < 30 && !blockers.length; i++) {
      blockers = (await db.pool.query('SELECT pg_blocking_pids($1) pids', [writerPid])).rows[0]
        .pids;
      if (!blockers.length) await new Promise((r) => setTimeout(r, 10));
    }
    assert.deepEqual(blockers, [projectionPid]);
    const waiting = (
      await db.pool.query('SELECT wait_event_type,wait_event FROM pg_stat_activity WHERE pid=$1', [
        writerPid,
      ])
    ).rows[0];
    assert.equal(waiting.wait_event_type, 'Lock');
    // Release the projection: the unchanged writer succeeds, with no timeout/lock bypass.
    await projection.query('ROLLBACK');
    assert.equal(await pending, null);
    await writer.query('ROLLBACK');
    const report = {
      date: new Date().toISOString(),
      assertion:
        'INSERT file_references takes an FK KEY SHARE on files; the current FOR UPDATE writer waits on this projection transaction.',
      blockingPidMatched: true,
      waiting,
      writerSucceededAfterProjectionRollback: true,
      scope:
        'Functional lock diagnosis, not a performance series or proposed optimization. No locks or checks changed.',
    };
    await writeFile(
      '.local/session-7-file-lock-diagnostic.json',
      JSON.stringify(report, null, 2) + '\n',
    );
    console.log(JSON.stringify(report));
  } finally {
    await projection.query('ROLLBACK');
    await writer.query('ROLLBACK');
    projection.release();
    writer.release();
    await db.close();
  }
});
