import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { testDatabase } from './database.ts';
await test('Real collaboration migrations: scope, bounds, revisions, receipts and account deletion', async () => {
  const db = await testDatabase();
  try {
    const insert = (workspace: string, snapshot: Buffer) =>
      db.pool.query(
        'INSERT INTO collaboration_documents(workspace_id,page_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,2,2)',
        [workspace, db.page, db.generation, snapshot],
      );
    const other = randomUUID();
    await db.pool.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Other',$2)", [
      other,
      other,
    ]);
    await assert.rejects(insert(other, Buffer.from([0, 0])), { code: '23503' });
    await assert.rejects(insert(db.workspace, Buffer.alloc(1048577)), { code: '23514' });
    await insert(db.workspace, Buffer.from([0, 0]));
    await assert.rejects(
      db.pool.query('UPDATE collaboration_documents SET projection_revision=2 WHERE page_id=$1', [
        db.page,
      ]),
      { code: '23514' },
    );
    await assert.rejects(
      db.pool.query(
        'INSERT INTO collaboration_updates(workspace_id,page_id,generation,revision,update) VALUES($1,$2,$3,1,$4)',
        [db.workspace, db.page, randomUUID(), Buffer.from([0, 0])],
      ),
      { code: '23503' },
    );
    await db.pool.query(
      'INSERT INTO collaboration_receipts(workspace_id,page_id,generation,actor_id,receipt,revision,update_hash) VALUES($1,$2,$3,$4,$5,0,$6)',
      [db.workspace, db.page, db.generation, db.actor, randomUUID(), 'a'.repeat(64)],
    );
    await db.pool.query('DELETE FROM auth_users WHERE id=$1', [db.user]);
    assert.equal(
      (await db.pool.query('SELECT user_id FROM actors WHERE id=$1', [db.actor])).rows[0].user_id,
      null,
    );
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS count FROM collaboration_receipts')).rows[0]
        .count,
      1,
    );
    await db.pool.query('DELETE FROM workspaces WHERE id=$1', [db.workspace]);
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS count FROM collaboration_receipts')).rows[0]
        .count,
      0,
    );
    console.log(
      'PASS migrations: foreign workspace/generation, >1 MiB and impossible revisions rejected; receipts survive personal account deletion',
    );
  } finally {
    await db.close();
  }
});
