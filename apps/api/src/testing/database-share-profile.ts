import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { PoolClient } from '@memoria/db';
type QueryResult = { rowCount: number | null; rows: unknown[] };
import { runMeasuredSeries } from '../../../../scripts/measurement-memory.mjs';
import type { Preparation } from '../../../../scripts/measurement-memory.mjs';
import { DatabaseService } from '../database.module.ts';
import type { databaseHttpHarness, Reader } from './database-http-fixture.ts';

type QueryTiming = { sql: string; ms: number; rows: number; start: number; end: number };
type Trace = {
  queries: QueryTiming[];
  reconciliationMs?: number;
  functionsBefore?: unknown[];
  functionsAfter?: unknown[];
  reconciliationScope?: unknown[];
};
/** Diagnostic only: split deferred reconciliation before COMMIT, never a qualification sample. */
export async function profileDatabaseShare(
  h: Awaited<ReturnType<typeof databaseHttpHarness>>,
  owner: Reader,
  page: string,
  member: string,
  preparation: Preparation,
  options?: { kind: 'role' | 'remove'; reset: () => Promise<void> },
) {
  const kind = options?.kind ?? 'share';
  const pool = h.app.get(DatabaseService).pool;
  const wrapped = new WeakSet<PoolClient>();
  let trace: Trace | undefined;
  const explain = new Map<string, { sql: string; values: unknown[] }>();
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    const original = client.query;
    client.query = new Proxy(original, {
      apply(fn, scope, args) {
        const current = trace;
        if (!current) return Reflect.apply(fn, scope, args);
        const config = args[0] as string | { text: string; values?: unknown[] };
        const sql = typeof config === 'string' ? config : config.text;
        const values = typeof config === 'string' ? args[1] : (config.values ?? args[1]);
        if (
          /^select/i.test(sql) &&
          (/from "pages"/i.test(sql) || /from access_subjects s/i.test(sql))
        )
          explain.set(/from "pages"/i.test(sql) ? 'pages' : 'grants', {
            sql,
            values: Array.isArray(values) ? values : [],
          });
        if (kind === 'role' && /^update\s+"workspace_members"/i.test(sql))
          explain.set('role-update', { sql, values: Array.isArray(values) ? values : [] });
        if (kind === 'remove' && /^delete\s+from\s+"workspace_members"/i.test(sql))
          explain.set('member-delete', { sql, values: Array.isArray(values) ? values : [] });
        const record = (
          start: number,
          result: { rowCount?: number | null; rows?: unknown[] } | undefined,
        ) => {
          const end = performance.now();
          current.queries.push({
            sql,
            start,
            end,
            ms: end - start,
            rows: result?.rowCount ?? result?.rows?.length ?? 0,
          });
        };
        const callback = args.at(-1) as unknown;
        if (typeof callback === 'function') {
          const start = performance.now();
          args[args.length - 1] = (...result: unknown[]) => {
            record(start, result[1] as QueryResult | undefined);
            return Reflect.apply(callback, undefined, result);
          };
          return Reflect.apply(fn, scope, args);
        }
        return (async () => {
          const raw = (text: string) => Reflect.apply(fn, scope, [text]) as Promise<QueryResult>;
          if (/^commit$/i.test(sql.trim())) {
            const stats =
              'SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname=current_schema() ORDER BY funcname';
            current.functionsBefore = (await raw(stats)).rows;
            current.reconciliationScope = (
              await raw(
                'SELECT member_ids IS NULL AS all_members,cardinality(member_ids) AS members,page_ids IS NULL AS all_pages,cardinality(page_ids) AS pages FROM page_access_pending',
              )
            ).rows;
            const start = performance.now();
            await raw('SET CONSTRAINTS content_access_commit IMMEDIATE');
            current.reconciliationMs = performance.now() - start;
            current.functionsAfter = (await raw(stats)).rows;
          }
          const start = performance.now();
          const result = (await Reflect.apply(fn, scope, args)) as QueryResult;
          record(start, result);
          if (/^begin$/i.test(sql.trim())) await raw("SET LOCAL track_functions='all'");
          return result;
        })();
      },
    });
  };
  pool.on('acquire', instrument);
  const reports: unknown[] = [];
  const route = `/api/internal/workspaces/${owner.workspace}/pages/${page}/shares`;
  try {
    for (let series = 1; series <= 3; series++) {
      await h.prove(owner);
      const { result, hygiene } = await runMeasuredSeries(
        `database-http-${kind}-profile-${series}`,
        async () => {
          const samples = [];
          for (let n = 0; n < 6; n++) {
            const cycle = performance.now();
            let body: Record<string, unknown>, path: string;
            if (options) {
              await options.reset();
              body = { expectedRole: 'guest', ...(kind === 'role' ? { role: 'member' } : {}) };
              path =
                `/api/internal/workspaces/${owner.workspace}/members/${member}` +
                (kind === 'role' ? '/role' : '');
            } else {
              const state = await h.call(owner, {}, route, {}, 'GET');
              assert.equal(state.status, 200);
              body = {
                expectedAccessVersion: state.data.accessVersion,
                level: n % 2 ? 'edit' : 'read',
              };
              path = `${route}/${member}`;
            }
            trace = { queries: [] };
            const response = await h.call(
              owner,
              body,
              path,
              {},
              kind === 'remove' ? 'DELETE' : 'PUT',
            );
            const captured = trace;
            trace = undefined;
            assert.equal(response.status, 200, String(response.data.code));
            assert(captured.reconciliationMs !== undefined, 'Real deferred reconciliation traced');
            samples.push({ server: response.server, roundTrip: response.roundTrip, ...captured });
            console.log(
              JSON.stringify({
                profile: true,
                series,
                sample: n + 1,
                server: response.server,
                reconciliation: captured.reconciliationMs,
                queries: captured.queries.map((q) => ({
                  ms: q.ms,
                  rows: q.rows,
                  kind: q.sql.slice(0, 60),
                })),
              }),
            );
            await delay(Math.max(0, 2150 - (performance.now() - cycle)));
          }
          const plans = [];
          if (options)
            assert(
              explain.has(kind === 'role' ? 'role-update' : 'member-delete'),
              'Actual native membership statement captured',
            );
          for (const [name, query] of explain) {
            if (options) await options.reset();
            const c = await h.f.db.pool.connect();
            try {
              await c.query('BEGIN');
              if (options) await c.query('SELECT database_lock_workspace($1)', [owner.workspace]);
              const result = await c.query(
                'EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON) ' + query.sql,
                query.values,
              );
              plans.push({ name, sql: query.sql, plan: result.rows[0]['QUERY PLAN'][0] });
              if (options) {
                const reconciliation = await c.query(
                  `EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON)
                   SELECT e.* FROM page_access_pending p
                   CROSS JOIN LATERAL content_access_effects_bounded(p.workspace_id,NULL,true,p.member_ids,p.page_ids) e
                   WHERE p.workspace_id=$1`,
                  [owner.workspace],
                );
                plans.push({
                  name: 'pending-access-effects',
                  sql: 'actual pending scope after membership statement',
                  plan: reconciliation.rows[0]['QUERY PLAN'][0],
                });
              }
            } finally {
              await c.query('ROLLBACK');
              c.release();
            }
          }
          return { samples, plans };
        },
        { preparation },
      );
      reports.push({ series, hygiene, ...result });
      await writeFile(
        `.local/session-6d-${kind}-profile.json`,
        JSON.stringify(
          {
            protocol:
              'Three diagnostic series, six genuine HTTP mutations each; no concurrent writers. Same full rights fixture. Client-side PG timing includes transfer/decoding but excludes later Drizzle mapping; gaps include framework and instrumentation. track_functions=all; force deferred content_access_commit before COMMIT to expose reconciliation and pg_stat_xact_user_functions. These instrumented latencies are not qualification samples. EXPLAIN ANALYZE uses captured statements inside a rolled-back transaction; the role fixture is restored with its 100 grants before each sample and plan. No parameter values or credentials in output.',
            kind,
            preparation,
            reports,
          },
          null,
          2,
        ) + '\n',
      );
    }
  } finally {
    trace = undefined;
    pool.off('acquire', instrument);
  }
}
