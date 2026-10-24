import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { resolveAccess } from '../service/access.ts';
import { Revocations } from '../service/revocations.ts';
await test('Real revocation locks precede commit; notify and missing-notify fallback recheck SQL', async () => {
  const db = await testDatabase();
  const identity = { ...db, key: 'connection' };
  let revoked = false,
    checks = 0;
  const watcher = new Revocations(
    db.url,
    async () => {
      checks++;
      revoked = !(await resolveAccess(db.pool, [identity])).has(identity.key);
    },
    () => {
      throw new Error('Unexpected control failure');
    },
  );
  try {
    await watcher.start();
    assert((await resolveAccess(db.pool, [identity])).has(identity.key));
    await db.client.query('BEGIN');
    await db.client.query('SELECT id FROM pages WHERE id=$1 FOR NO KEY UPDATE', [db.page]);
    let done = false;
    const deletion = db.pool
      .query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
        db.workspace,
        db.user,
      ])
      .then(() => {
        done = true;
      });
    await delay(100);
    assert(!done);
    assert((await resolveAccess(db.client, [identity])).has(identity.key));
    await db.client.query('COMMIT');
    await deletion;
    const wait = async () => {
      const deadline = Date.now() + 5500;
      while (!revoked && Date.now() < deadline) await delay(20);
      assert(revoked);
    };
    await wait();
    assert(checks > 0);
    await db.pool.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
      [db.workspace, db.user],
    );
    revoked = false;
    await db.pool.query('ALTER TABLE auth_sessions DISABLE TRIGGER collab_notify_session');
    const started = Date.now();
    await db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [db.session]);
    await wait();
    assert(Date.now() - started < 5500);
    console.log(
      'PASS revocation: membership deletion waits for page writer; commit notification rechecks access; missing session notification handled within 5.5 s test tolerance',
    );
  } finally {
    await watcher.close();
    await db.close();
  }
});
