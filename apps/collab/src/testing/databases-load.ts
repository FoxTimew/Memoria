import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile, mkdir } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { DatabaseLimits } from '@memoria/db';
import type { TestDatabase } from './database.ts';
import { databaseWriters } from './database-writers.ts';

/** First blocking gate: real SQL mutation cost. HTTP and editor waiting can only add to it. */
export async function measureDatabaseBarriers(fixture: TestDatabase, limits: DatabaseLimits) {
  const { pool, workspace, page } = fixture;
  const count = limits.basesPerWorkspace;
  assert.equal(count, 50, 'Qualification fixture requires defaults');
  assert.equal(limits.rowsPerWorkspace, 50_000);
  const existing = (await pool.query('SELECT id FROM databases WHERE workspace_id=$1', [workspace]))
    .rows[0].id;
  const bases: string[] = [existing];
  const targetUsers: string[] = [];
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    const ordinary: string[] = [page];
    for (let i = 1; i < 1000; i++) ordinary.push(randomUUID());
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
  const p95 = (values: number[]) =>
    [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
  const reports: {
    series: number;
    freeBytes: number;
    power: unknown;
    samples: number[];
    p95: number;
    waitP95: number;
    confirmationP95: number;
    editors: Awaited<ReturnType<Awaited<ReturnType<typeof databaseWriters>>['run']>>;
  }[] = [];
  await mkdir('.local', { recursive: true });
  const writers = await databaseWriters(fixture, bases);
  try {
    for (let series = 1; series <= 3; series++) {
      const power = JSON.parse(
        execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
          encoding: 'utf8',
          windowsHide: true,
        }),
      );
      const freeBytes = freemem();
      console.log(JSON.stringify({ series, power, freeBytes }));
      assert(power.allowed, 'AC_POWER_REQUIRED');
      assert(freeBytes >= 3 * 1024 ** 3, 'FREE_RAM_BELOW_3_GIB');
      const samples: number[] = [];
      // Includes deferred access reconciliation and durable commit. No simulated mutex.
      const editors = await writers.run(async () => {
        for (let i = 0; i < 32; i++) {
          const start = performance.now();
          await pool.query('UPDATE workspace_members SET role=$1 WHERE id=$2', [
            i % 2 ? 'member' : 'guest',
            targetUsers[0],
          ]);
          if (i >= 2) samples.push(performance.now() - start);
        }
      });
      const mutationP95 = p95(samples),
        waitP95 = p95(editors.allWaits),
        confirmationP95 = p95(editors.confirmations);
      reports.push({
        series,
        freeBytes,
        power,
        samples,
        p95: mutationP95,
        waitP95,
        confirmationP95,
        editors,
      });
      console.log(
        JSON.stringify({
          series,
          p95: mutationP95,
          waitP95,
          confirmationP95,
          samples: samples.length,
          writes: editors.confirmations.length,
        }),
      );
      await writeFile(
        '.local/session-6a-barriers-measurement.json',
        JSON.stringify(
          { fixture: { pages: 1000, bases: 50, rows: 50000, members: 100, grants: 5000 }, reports },
          null,
          2,
        ) + '\n',
      );
    }
    const median = reports.map((r) => r.p95).sort((a, b) => a - b)[1]!;
    const waitMedian = reports.map((r) => r.waitP95).sort((a, b) => a - b)[1]!;
    const confirmationMedian = reports.map((r) => r.confirmationP95).sort((a, b) => a - b)[1]!;
    console.log(
      JSON.stringify({
        gate: 'rights_sql_commit_ms',
        medianP95: median,
        limit: 500,
        waitMedian,
        confirmationMedian,
        passed: median < 500 && waitMedian < 100 && confirmationMedian < 200,
      }),
    );
    assert(
      median < 500,
      'STOP_6A_RIGHTS_BARRIER_BUDGET: SQL cost alone exceeds the 500 ms server target',
    );
    assert(waitMedian < 100, 'STOP_6A_EDITOR_WAIT_BUDGET: observed SQL lock waits exceed 100 ms');
    assert(
      confirmationMedian < 200,
      'STOP_6A_CONFIRMATION_BUDGET: journal confirmations exceed 200 ms',
    );
  } finally {
    await writers.close();
  }
}
