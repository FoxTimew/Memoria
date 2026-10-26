import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { testDatabase } from './database.ts';

test('Targeted reconciliation equals full rights and never shrinks a global pending scope', async () => {
  const db = await testDatabase();
  const { pool, workspace, page } = db;
  const a = randomUUID(),
    b = randomUUID(),
    sa = randomUUID(),
    sb = randomUUID(),
    child = randomUUID();
  try {
    for (const member of [a, b]) {
      const user = randomUUID();
      await pool.query(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Scope fixture',$2,true)",
        [user, user + '@example.test'],
      );
      await pool.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
        [member, workspace, user],
      );
    }
    await pool.query(
      "INSERT INTO pages(id,workspace_id,parent_id,position) VALUES($1,$2,$3,'a0')",
      [child, workspace, page],
    );
    await pool.query(
      "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3),($4,$2,'member',$5)",
      [sa, workspace, a, sb, b],
    );
    const oracle = async () => {
      const actual = (
        await pool.query(
          "SELECT member_id,page_id,level FROM page_access_state WHERE workspace_id=$1 AND level<>'none' ORDER BY member_id,page_id",
          [workspace],
        )
      ).rows;
      const expected = (
        await pool.query('SELECT * FROM content_effective_access($1) ORDER BY member_id,page_id', [
          workspace,
        ])
      ).rows;
      assert.deepEqual(actual, expected);
      assert.equal((await pool.query('SELECT * FROM page_access_pending')).rowCount, 0);
    };
    const before = (
      await pool.query(
        'SELECT * FROM page_access_state WHERE workspace_id=$1 AND member_id=$2 ORDER BY page_id',
        [workspace, b],
      )
    ).rows;
    const c = await pool.connect();
    const scope = async () =>
      (
        await c.query('SELECT member_ids FROM page_access_pending WHERE workspace_id=$1', [
          workspace,
        ])
      ).rows[0]?.member_ids as string[] | null | undefined;
    try {
      await c.query('BEGIN');
      await c.query("UPDATE workspace_members SET role='guest' WHERE id=$1", [a]);
      assert.deepEqual(await scope(), [a]);
      await c.query('COMMIT');
      await oracle();
      assert.deepEqual(
        (
          await pool.query(
            'SELECT * FROM page_access_state WHERE workspace_id=$1 AND member_id=$2 ORDER BY page_id',
            [workspace, b],
          )
        ).rows,
        before,
        'unchanged person epochs remain byte-for-byte unchanged',
      );
      assert.equal(
        (
          await pool.query(
            "SELECT count(*) n FROM page_access_state WHERE member_id=$1 AND level='none'",
            [a],
          )
        ).rows[0].n,
        '2',
      );
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO access_grants(workspace_id,subject_id,resource_type,resource_id,level,inherit) VALUES($1,$2,'page',$3,'read',true)",
        [workspace, sa, page],
      );
      assert.deepEqual(await scope(), [a]);
      await c.query('COMMIT');
      await oracle();
      await c.query('BEGIN');
      await c.query("UPDATE workspace_members SET role='member' WHERE id=$1", [a]);
      assert.deepEqual(await scope(), [a], 'promotion and grant cleanup stay person-local');
      await c.query('COMMIT');
      await oracle();
      assert.equal(
        (await pool.query('SELECT * FROM access_grants WHERE subject_id=$1', [sa])).rowCount,
        0,
      );
      // Two scoped mutations must union the final targets, not use the first trigger's NEW record.
      await c.query('BEGIN');
      await c.query("UPDATE workspace_members SET role='guest' WHERE id=ANY($1::uuid[])", [[a, b]]);
      assert.deepEqual((await scope())?.sort(), [a, b].sort());
      await c.query('COMMIT');
      await oracle();
      // Global tree effect then scoped change, and the reverse order.
      for (const globalFirst of [true, false]) {
        await c.query('BEGIN');
        const global = () =>
          c.query(
            'UPDATE pages SET deleted_at=CASE WHEN deleted_at IS NULL THEN now() ELSE NULL END WHERE id=$1',
            [child],
          );
        const local = () =>
          c.query(
            "UPDATE workspace_members SET role=CASE role WHEN 'guest' THEN 'member' ELSE 'guest' END WHERE id=$1",
            [a],
          );
        if (globalFirst) {
          await global();
          await local();
        } else {
          await local();
          await global();
        }
        assert.equal(await scope(), null);
        await c.query('COMMIT');
        await oracle();
      }
      // Moving a grant between subjects must include both its old and new owner.
      const grant = randomUUID();
      await pool.query(
        "INSERT INTO access_grants(id,workspace_id,subject_id,resource_type,resource_id,level,inherit) VALUES($1,$2,$3,'page',$4,'edit',true)",
        [grant, workspace, sa, page],
      );
      await c.query('BEGIN');
      await c.query('UPDATE access_grants SET subject_id=$1 WHERE id=$2', [sb, grant]);
      assert.deepEqual((await scope())?.sort(), [a, b].sort());
      await c.query('COMMIT');
      await oracle();
      const epochs = (
        await pool.query('SELECT * FROM page_access_state ORDER BY member_id,page_id')
      ).rows;
      await c.query('BEGIN');
      await c.query("UPDATE workspace_members SET role='owner' WHERE id=$1", [b]);
      await c.query('ROLLBACK');
      assert.deepEqual(
        (await pool.query('SELECT * FROM page_access_state ORDER BY member_id,page_id')).rows,
        epochs,
      );
      await oracle();
      // Cascaded grant deletion can no longer resolve the vanished subject: safe global fallback.
      await c.query('BEGIN');
      await c.query('DELETE FROM access_subjects WHERE id=$1', [sb]);
      assert.equal(await scope(), null);
      await c.query('COMMIT');
      await oracle();
      await pool.query('DELETE FROM workspace_members WHERE id=$1', [b]);
      await oracle();
    } finally {
      await c.query('ROLLBACK');
      c.release();
    }
  } finally {
    await db.close();
  }
});
