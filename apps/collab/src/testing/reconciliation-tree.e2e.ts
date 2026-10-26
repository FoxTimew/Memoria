import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { readDatabaseLimits } from '@memoria/db';
import { testDatabase } from './database.ts';
import { databaseLoadFixture } from './databases-fixture.ts';

test('full 1,000-page / 50,000-row fixture: subtree reconciliation equals complete oracle', async () => {
  const db = await testDatabase({ queryTimeoutMs: 120000 });
  try {
    const base = randomUUID(),
      row = randomUUID();
    await db.pool.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
      base,
      db.workspace,
      db.page,
    ]);
    await db.pool.query(
      "INSERT INTO pages(id,workspace_id,kind,position) VALUES($1,$2,'database_row','a0')",
      [row, db.workspace],
    );
    await db.pool.query(
      'INSERT INTO database_rows(workspace_id,database_id,page_id) VALUES($1,$2,$3)',
      [db.workspace, base, row],
    );
    const { tree } = await databaseLoadFixture(db, readDatabaseLimits());
    const oracle = async () => {
      const r = await db.pool.query(
        `WITH actual AS (SELECT member_id,page_id,level FROM page_access_state WHERE workspace_id=$1 AND level<>'none'), expected AS (SELECT * FROM content_effective_access($1)), delta AS ((SELECT * FROM actual EXCEPT SELECT * FROM expected) UNION ALL (SELECT * FROM expected EXCEPT SELECT * FROM actual)) SELECT count(*) n FROM delta`,
        [db.workspace],
      );
      assert.equal(r.rows[0].n, '0');
      assert.equal(
        (
          await db.pool.query('SELECT * FROM page_access_pending WHERE workspace_id=$1', [
            db.workspace,
          ])
        ).rowCount,
        0,
      );
    };
    await oracle();
    for (const sql of [
      'UPDATE pages SET parent_id=$2 WHERE id=$1',
      'UPDATE pages SET deleted_at=now() WHERE id=$1',
      'UPDATE pages SET deleted_at=NULL WHERE id=$1',
    ]) {
      await db.pool.query(sql, sql.includes('$2') ? [tree.root, tree.destination] : [tree.root]);
      await oracle();
    }
    // A descendant moved away after the first mutation must remain in the union.
    const child = (
      await db.pool.query('SELECT id FROM pages WHERE parent_id=$1 ORDER BY id LIMIT 1', [
        tree.root,
      ])
    ).rows[0].id;
    const c = await db.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [tree.root]);
      await c.query("UPDATE pages SET parent_id=$1,position='a999999' WHERE id=$2", [
        tree.parent,
        child,
      ]);
      const scope = (
        await c.query('SELECT page_ids FROM page_access_pending WHERE workspace_id=$1', [
          db.workspace,
        ])
      ).rows[0].page_ids as string[];
      assert(scope.includes(child));
      assert(scope.includes(tree.root));
      await c.query('COMMIT');
      await oracle();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
    const before = (
      await db.pool.query(
        "SELECT md5(string_agg(member_id::text||page_id::text||level||version::text,'|' ORDER BY member_id,page_id)) value FROM page_access_state WHERE workspace_id=$1",
        [db.workspace],
      )
    ).rows[0].value;
    await db.client.query('BEGIN');
    await db.client.query('UPDATE pages SET deleted_at=NULL WHERE id=$1', [tree.root]);
    await db.client.query('ROLLBACK');
    await oracle();
    const after = (
      await db.pool.query(
        "SELECT md5(string_agg(member_id::text||page_id::text||level||version::text,'|' ORDER BY member_id,page_id)) value FROM page_access_state WHERE workspace_id=$1",
        [db.workspace],
      )
    ).rows[0].value;
    assert.equal(after, before);
  } finally {
    await db.close();
  }
});
