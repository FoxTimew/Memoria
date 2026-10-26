import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import type { DatabaseLimits } from '@memoria/db';
import type { TestDatabase } from './database.ts';
/** Shared, unchanged bound fixture for profiling and both transports. */
export async function databaseLoadFixture(fixture: TestDatabase, limits: DatabaseLimits) {
  const { pool, workspace, page } = fixture;
  const count = limits.basesPerWorkspace;
  assert.equal(count, 50, 'Qualification fixture requires defaults');
  assert.equal(limits.rowsPerWorkspace, 50_000);
  const existing = (await pool.query('SELECT id FROM databases WHERE workspace_id=$1', [workspace]))
    .rows[0].id;
  const bases: string[] = [existing];
  const targetUsers: string[] = [];
  const ordinary: string[] = [page];
  for (let i = 1; i < 1000; i++) ordinary.push(randomUUID());
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    // 20 branches, depth 50; the 50 containers are among the ordinary pages.
    await c.query(
      `INSERT INTO pages(id,workspace_id,parent_id,title,position)
      SELECT id,$1,CASE WHEN n%50=0 THEN NULL ELSE ($3::uuid[])[n] END,'Fixture '||n,'a'||lpad(n::text,6,'0')
      FROM unnest($2::uuid[]) WITH ORDINALITY t(id,n)`,
      [workspace, ordinary.slice(1), ordinary],
    );
    for (let i = 1; i < count; i++) {
      const id = randomUUID();
      bases.push(id);
      await c.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
        id,
        workspace,
        ordinary[i * 20],
      ]);
    }
    console.log('Fixture: containers ready.');
    for (let i = 1; i < 100; i++) {
      const user = randomUUID(),
        member = randomUUID();
      await c.query(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Fixture',$2,true)",
        [user, user + '@example.test'],
      );
      await c.query(
        'INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)',
        [member, workspace, user, i < 51 ? 'guest' : 'member'],
      );
      await c.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        user,
      ]);
      if (i === 51) targetUsers.push(member);
      if (i < 51) {
        const subject = randomUUID();
        await c.query(
          "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3)",
          [subject, workspace, member],
        );
        await c.query(
          `INSERT INTO access_grants(workspace_id,subject_id,resource_type,resource_id,level,inherit)
         SELECT $1,$2,'page',id,'edit',true FROM unnest($3::uuid[]) t(id)`,
          [workspace, subject, ordinary.slice(i * 10, i * 10 + 100)],
        );
      }
    }
    await c.query('COMMIT');
    console.log('Fixture: memberships and grants committed.');
    // Isolated fixture setup is not a timed sample. 50,000 rows, split across 50 bases.
    for (let i = 0; i < count; i++) {
      const n = 1000 - (i === 0 ? 1 : 0),
        ids = Array.from({ length: n }, () => randomUUID());
      await c.query('BEGIN');
      await c.query(
        "INSERT INTO pages(id,workspace_id,kind,position,title) SELECT id,$1,'database_row','a0','Row' FROM unnest($2::uuid[]) t(id)",
        [workspace, ids],
      );
      await c.query(
        'INSERT INTO database_rows(workspace_id,database_id,page_id) SELECT $1,$2,id FROM unnest($3::uuid[]) t(id)',
        [workspace, bases[i], ids],
      );
      await c.query('COMMIT');
    }
    await c.query('ANALYZE');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
  console.log(
    'Fixture ready: 1,000 ordinary pages, 50 bases, 50,000 rows, 100 memberships, 5,000 grants, depth 50.',
  );
  assert.equal(
    (
      await pool.query(
        "SELECT count(*) n FROM pages WHERE workspace_id=$1 AND kind='database_row'",
        [workspace],
      )
    ).rows[0].n,
    '50000',
  );
  assert.equal(
    (
      await pool.query(
        'SELECT count(*) n FROM page_access_state WHERE workspace_id=$1 AND page_id IN(SELECT page_id FROM database_rows WHERE workspace_id=$1)',
        [workspace],
      )
    ).rows[0].n,
    '0',
  );

  return {
    bases,
    targetUsers,
    tree: {
      root: ordinary[510]!,
      parent: ordinary[509]!,
      destination: ordinary[750]!,
      descendants: 40,
    },
  };
}
