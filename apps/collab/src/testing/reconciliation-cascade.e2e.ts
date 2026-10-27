import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import type { PoolClient } from '@memoria/db';
import { testDatabase } from './database.ts';

await test('cascaded rights reconciliation: exact scope, full oracle, rollback and live SQL writer', async (t) => {
  const f = await testDatabase();
  const c = await f.pool.connect(),
    writer = await f.pool.connect();
  const w = f.workspace,
    members = [randomUUID(), randomUUID()],
    subjects = [randomUUID(), randomUUID()],
    users = [randomUUID(), randomUUID()];
  const session = randomUUID(),
    ordinary = [f.page, ...Array.from({ length: 99 }, () => randomUUID())];
  const scope = async () =>
    (await c.query('SELECT member_ids FROM page_access_pending WHERE workspace_id=$1', [w])).rows[0]
      ?.member_ids as string[] | null | undefined;
  const snapshot = (db: PoolClient) =>
    db.query(
      'SELECT member_id,page_id,level,version FROM page_access_state WHERE workspace_id=$1 ORDER BY member_id,page_id',
      [w],
    );
  const oracle = async (db: PoolClient) => {
    await db.query('SET CONSTRAINTS content_access_commit IMMEDIATE');
    const actual = await db.query(
      "SELECT member_id,page_id,level FROM page_access_state WHERE workspace_id=$1 AND level<>'none' ORDER BY member_id,page_id",
      [w],
    );
    const full = await db.query(
      'SELECT * FROM content_effective_access($1) ORDER BY member_id,page_id',
      [w],
    );
    assert.deepEqual(actual.rows, full.rows);
    assert.equal(
      (await db.query('SELECT * FROM page_access_pending WHERE workspace_id=$1', [w])).rowCount,
      0,
    );
  };
  const rolled = async (work: () => Promise<void>) => {
    const before = (await snapshot(c)).rows;
    await c.query('BEGIN');
    try {
      await work();
      await oracle(c);
    } finally {
      await c.query('ROLLBACK');
    }
    assert.deepEqual(
      (await snapshot(c)).rows,
      before,
      'all epochs and decisions restored by rollback',
    );
  };
  try {
    await c.query('BEGIN');
    await c.query(
      "INSERT INTO pages(id,workspace_id,position) SELECT id,$1,'a'||lpad(n::text,4,'0') FROM unnest($2::uuid[]) WITH ORDINALITY t(id,n)",
      [w, ordinary.slice(1)],
    );
    for (let n = 0; n < 2; n++) {
      await c.query(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Cascade',$2,true)",
        [users[n], users[n] + '@example.test'],
      );
      await c.query(
        "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'guest')",
        [members[n], w, users[n]],
      );
      await c.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        w,
        users[n],
      ]);
      await c.query(
        "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3)",
        [subjects[n], w, members[n]],
      );
      await c.query(
        "INSERT INTO access_grants(workspace_id,subject_id,resource_id,level) SELECT $1,$2,id,'edit' FROM unnest($3::uuid[]) t(id)",
        [w, subjects[n], ordinary],
      );
    }
    await c.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [session, users[0], randomUUID()],
    );
    await c.query('COMMIT');
    const fk = await c.query(
      "SELECT condeferrable,confdeltype FROM pg_constraint WHERE conrelid='access_grants'::regclass AND confrelid='access_subjects'::regclass",
    );
    assert.deepEqual(
      fk.rows,
      [{ condeferrable: false, confdeltype: 'c' }],
      'missing subject must imply its immediate FK cascade',
    );

    await t.test('direct grant deletion still queues its existing subject', () =>
      rolled(async () => {
        await c.query('DELETE FROM access_grants WHERE subject_id=$1', [subjects[0]]);
        assert.deepEqual(await scope(), [members[0]]);
      }),
    );
    await t.test(
      'deleting a subject with 100 grants queues only its OLD member; unrelated epochs unchanged',
      () =>
        rolled(async () => {
          const before = (await snapshot(c)).rows.filter((r) => r.member_id !== members[0]);
          await c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[0]]);
          assert.deepEqual(await scope(), [members[0]]);
          assert.equal(
            (await c.query('SELECT id FROM access_grants WHERE subject_id=$1', [subjects[0]]))
              .rowCount,
            0,
          );
          await oracle(c);
          assert.deepEqual(
            (await snapshot(c)).rows.filter((r) => r.member_id !== members[0]),
            before,
          );
        }),
    );
    await t.test(
      'membership cascade preserves scope and detached person, without broad reconciliation',
      () =>
        rolled(async () => {
          await c.query('DELETE FROM workspace_members WHERE id=$1', [members[0]]);
          assert.deepEqual(await scope(), [members[0]]);
          assert.equal(
            (await c.query('SELECT member_id FROM database_people WHERE id=$1', [members[0]]))
              .rows[0].member_id,
            null,
          );
        }),
    );
    await t.test('multiple subject cascades union affected people', () =>
      rolled(async () => {
        await c.query('DELETE FROM access_subjects WHERE id=ANY($1::uuid[])', [subjects]);
        assert.deepEqual((await scope())?.sort(), [...members].sort());
      }),
    );
    await t.test('grant reassignment followed by cascade keeps both old and new owners', () =>
      rolled(async () => {
        await c.query('DELETE FROM access_grants WHERE subject_id=$1 AND resource_id=$2', [
          subjects[1],
          f.page,
        ]);
        await c.query(
          'UPDATE access_grants SET subject_id=$1 WHERE subject_id=$2 AND resource_id=$3',
          [subjects[1], subjects[0], f.page],
        );
        await c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[0]]);
        assert.deepEqual((await scope())?.sort(), [...members].sort());
      }),
    );
    await t.test('global scope never shrinks, before or after a cascade', async () => {
      for (const first of [true, false])
        await rolled(async () => {
          const global = () => c.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [f.page]);
          const remove = () => c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[0]]);
          if (first) {
            await global();
            await remove();
          } else {
            await remove();
            await global();
          }
          assert.equal(await scope(), null);
        });
    });
    await t.test(
      'savepoint rollback discards cascade scope, then another subject can be deleted',
      () =>
        rolled(async () => {
          await c.query('SAVEPOINT before_cascade');
          await c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[0]]);
          await c.query('ROLLBACK TO before_cascade');
          assert.equal(await scope(), undefined);
          await c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[1]]);
          assert.deepEqual(await scope(), [members[1]]);
        }),
    );
    await t.test('immediate deferred constraints do not miss the parent event', () =>
      rolled(async () => {
        await c.query('SET CONSTRAINTS content_access_commit IMMEDIATE');
        await c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[0]]);
        assert.equal(await scope(), undefined);
        await oracle(c);
      }),
    );
    await t.test('unsupported API-key subject retains global fallback during its cascade', () =>
      rolled(async () => {
        const key = randomUUID(),
          actor = randomUUID(),
          subject = randomUUID();
        await c.query("INSERT INTO actors(id,workspace_id,kind) VALUES($1,$2,'api_key')", [
          actor,
          w,
        ]);
        await c.query(
          "INSERT INTO api_key_policies(id,workspace_id,actor_id,display_prefix) VALUES($1,$2,$3,'test')",
          [key, w, actor],
        );
        await c.query(
          "INSERT INTO access_subjects(id,workspace_id,kind,api_key_policy_id) VALUES($1,$2,'api_key',$3)",
          [subject, w, key],
        );
        await c.query(
          "INSERT INTO access_grants(workspace_id,subject_id,resource_id,level) VALUES($1,$2,$3,'read')",
          [w, subject, f.page],
        );
        await oracle(c);
        await c.query('SET CONSTRAINTS content_access_commit DEFERRED');
        await c.query('DELETE FROM access_subjects WHERE id=$1', [subject]);
        assert.equal(await scope(), null);
      }),
    );
    await t.test(
      'a writer really waits, then sees revocation after commit or unchanged access after rollback',
      async () => {
        const request = JSON.stringify([
          { key: 'page', userid: users[0], session, workspace: w, page: f.page },
        ]);
        for (const end of ['ROLLBACK', 'COMMIT']) {
          await c.query('BEGIN');
          await c.query('DELETE FROM access_subjects WHERE id=$1', [subjects[0]]);
          await writer.query('BEGIN');
          await writer.query("SET LOCAL lock_timeout='5s'");
          const pid = (await writer.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          const pending = writer.query('SELECT content_lock_document($1,$2)', [w, f.page]);
          void pending.catch(() => {});
          try {
            let blocked = false;
            for (let n = 0; n < 200; n++) {
              blocked = Boolean(
                (
                  await f.pool.query(
                    "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock' AND cardinality(pg_blocking_pids(pid))>0",
                    [pid],
                  )
                ).rowCount,
              );
              if (blocked) break;
              await delay(5);
            }
            assert(blocked, 'native writer waits for real held page barrier');
          } finally {
            await c.query(end);
          }
          await pending;
          assert.equal(
            (await writer.query('SELECT * FROM content_resolve_access($1::jsonb)', [request]))
              .rowCount,
            end === 'COMMIT' ? 0 : 1,
          );
          await writer.query('ROLLBACK');
        }
        await oracle(c);
      },
    );
  } finally {
    await c.query('ROLLBACK');
    await writer.query('ROLLBACK');
    c.release();
    writer.release();
    await f.close();
  }
});
