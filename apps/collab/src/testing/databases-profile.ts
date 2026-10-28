import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { mkdir, writeFile } from 'node:fs/promises';
import type { TestDatabase } from './database.ts';

/** No replacement of production functions: EXPLAIN and per-transaction function statistics only. */
export async function profileDatabaseMutation(db: TestDatabase, member: string) {
  const c = await db.pool.connect(),
    reports: unknown[] = [];
  await mkdir('.local', { recursive: true });
  try {
    const definitions = (
      await c.query<{ proname: string; source: string }>(
        `SELECT p.proname,pg_get_functiondef(p.oid) source FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=current_schema() AND p.proname IN ('content_reconcile_access','content_effective_access','content_access_effects','content_effective_access_scoped','content_access_effects_scoped','content_effective_access_bounded','content_access_effects_bounded')`,
      )
    ).rows;
    const reconcile = definitions.find((r) => r.proname === 'content_reconcile_access')!.source;
    const scoped = reconcile.includes('true,targets');
    const bounded = reconcile.includes('content_access_effects_bounded');
    const body = reconcile
      .slice(
        reconcile.indexOf('WITH changed AS MATERIALIZED'),
        reconcile.indexOf('DELETE FROM page_access_pending'),
      )
      .trim()
      .replaceAll('NEW.workspace_id', '$1::uuid')
      .replaceAll('after_level,v', 'after_level,$2::integer')
      .replaceAll('access_version=v', 'access_version=$2::integer')
      .replaceAll('true,targets,resources', 'true,$3::uuid[],$4::uuid[]')
      .replaceAll('true,targets', 'true,$3::uuid[]');
    assert(body.startsWith('WITH changed') && body.includes('content_access_effects'));
    for (let series = 1; series <= 3; series++) {
      const power = JSON.parse(
          execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
            encoding: 'utf8',
            windowsHide: true,
          }),
        ),
        freeBytes = freemem();
      console.log(JSON.stringify({ profile: true, series, power, freeBytes }));
      assert(power.allowed, 'AC_POWER_REQUIRED');
      assert(freeBytes >= 3 * 1024 ** 3, 'FREE_RAM_BELOW_3_GIB');
      const samples: unknown[] = [];
      for (let i = 0; i < 6; i++) {
        await c.query('BEGIN');
        await c.query("SET LOCAL track_functions='all'");
        const start = performance.now();
        const plan = (
          await c.query(
            'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) UPDATE workspace_members SET role=$1 WHERE id=$2',
            [i % 2 ? 'member' : 'guest', member],
          )
        ).rows[0]['QUERY PLAN'][0];
        const updateMs = performance.now() - start;
        const before = (
          await c.query(
            'SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname=current_schema() ORDER BY funcname',
          )
        ).rows;
        const reconcileStart = performance.now();
        await c.query('SET CONSTRAINTS content_access_commit IMMEDIATE');
        const reconcileMs = performance.now() - reconcileStart;
        const after = (
          await c.query(
            'SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname=current_schema() ORDER BY funcname',
          )
        ).rows;
        const commitStart = performance.now();
        await c.query('COMMIT');
        const commitMs = performance.now() - commitStart;
        samples.push({
          role: i % 2 ? 'member' : 'guest',
          updateMs,
          reconcileMs,
          commitMs,
          plan,
          functionsBefore: before,
          functionsAfter: after,
        });
        console.log(JSON.stringify({ series, i, updateMs, reconcileMs, commitMs }));
      }
      // Explain the exact reconciliation CTE with the same pending delta, then rollback.
      await c.query('BEGIN');
      await c.query("UPDATE workspace_members SET role='guest' WHERE id=$1", [member]);
      const version = (
        await c.query('SELECT access_version FROM workspaces WHERE id=$1', [db.workspace])
      ).rows[0].access_version;
      const counts = (
        await c.query(
          `SELECT (SELECT count(*) FROM page_access_state WHERE workspace_id=$1 AND level<>'none') stored_pairs,
     (SELECT count(*) FROM content_effective_access($1)) calculated_pairs,
     (SELECT count(*) FROM content_access_effects($1,NULL,true)) changed_pairs,
     (SELECT count(DISTINCT member_id) FROM content_access_effects($1,NULL,true)) changed_people`,
          [db.workspace],
        )
      ).rows[0];
      const targetedCounts = scoped
        ? (
            await c.query(
              `SELECT (SELECT count(*) FROM page_access_state WHERE workspace_id=$1 AND member_id=$2 AND level<>'none') stored_pairs,
     (SELECT count(*) FROM content_effective_access_scoped($1,NULL,ARRAY[$2::uuid])) calculated_pairs,
     (SELECT count(*) FROM content_access_effects_scoped($1,NULL,true,ARRAY[$2::uuid])) changed_pairs`,
              [db.workspace, member],
            )
          ).rows[0]
        : null;
      const plan = (
        await c.query(
          'EXPLAIN (ANALYZE, BUFFERS, VERBOSE, FORMAT JSON) ' + body,
          bounded
            ? [db.workspace, version, [member], null]
            : scoped
              ? [db.workspace, version, [member]]
              : [db.workspace, version],
        )
      ).rows[0]['QUERY PLAN'][0];
      await c.query('ROLLBACK');
      reports.push({
        series,
        power,
        freeBytes,
        samples,
        counts,
        targetedCounts,
        reconciliationPlan: plan,
      });
      await writeFile(
        '.local/session-6a-role-profile.json',
        JSON.stringify({ definitions, reports }, null, 2) + '\n',
      );
      console.log(
        JSON.stringify({ series, counts, targetedCounts, reconcilePlanMs: plan['Execution Time'] }),
      );
    }
  } finally {
    await c.query('ROLLBACK');
    c.release();
  }
}
