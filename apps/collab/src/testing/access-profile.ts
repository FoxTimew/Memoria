import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import type { PoolClient, QueryConfig } from 'pg';
import { testDatabase } from './database.ts';
import { resolveAccess } from '../service/access.ts';

// Diagnostic only: disposable schema, real current resolver/functions, no global settings.
const output = process.argv[2];
if (!output?.startsWith('.local/')) throw new Error('Expected local diagnostic output');
const db = await testDatabase();
try {
  const factor = randomUUID();
  await db.client.query(
    "INSERT INTO auth_passkeys(id,user_id,public_key,credential_id,counter,device_type,backed_up) VALUES($1,$2,'diagnostic-not-a-key',$3,0,'singleDevice',false)",
    [factor, db.user, randomUUID()],
  );
  await db.client.query(
    "INSERT INTO session_assurance(session_id,method,verified_at,security_version,factor_id) VALUES($1,'passkey',now(),0,$2)",
    [db.session, factor],
  );
  await db.client.query(
    'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())',
    [db.workspace],
  );
  const power = JSON.parse(
    execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
      encoding: 'utf8',
      windowsHide: true,
    }),
  );
  const freeBytes = freemem();
  console.log(JSON.stringify({ power, freeBytes }));
  if (freeBytes < 3 * 1024 ** 3) throw new Error('RAM below 3 GiB; stop and ask developer');
  const requests = [{ ...db, key: db.user }];
  let captured!: QueryConfig;
  await resolveAccess(
    {
      query: async (query: QueryConfig) => {
        captured = query;
        return { rows: [] };
      },
    } as unknown as PoolClient,
    requests,
  );
  const execute = async () => assert.equal((await resolveAccess(db.client, requests)).size, 1);
  for (let i = 0; i < 20; i++) await execute();

  // Inspect nested function plans separately: auto_explain has instrumentation overhead.
  const nested: string[] = [];
  db.client.on('notice', (notice) => {
    if (notice.message?.startsWith('duration:')) nested.push(notice.message);
  });
  await db.client.query(
    "LOAD 'auto_explain'; SET auto_explain.log_analyze=on; SET auto_explain.log_buffers=on; SET auto_explain.log_nested_statements=on; SET auto_explain.log_format=json; SET auto_explain.log_level=notice; SET auto_explain.log_parameter_max_length=0; SET auto_explain.log_min_duration=0",
  );
  const parameter = String(captured.values![0]).replaceAll("'", "''");
  const plan = (
    await db.client.query(
      `EXPLAIN (ANALYZE,BUFFERS,VERBOSE,FORMAT JSON) EXECUTE "${captured.name}" ('${parameter}')`,
    )
  ).rows[0]['QUERY PLAN'];
  await db.client.query('SET auto_explain.log_min_duration=-1');
  const cases = [
    { name: 'resolver', execute },
    ...[
      'auth_session_is_strong',
      'auth_session_can_access_content',
      'auth_session_can_access_workspace',
    ].map((name) => ({
      name,
      execute: async () => {
        const two = name.endsWith('workspace');
        assert.equal(
          (
            await db.client.query({
              name: `profile-${name}`,
              text: `SELECT ${name}($1${two ? ',$2' : ''}) AS allowed`,
              values: two ? [db.session, db.workspace] : [db.session],
            })
          ).rows[0].allowed,
          true,
        );
      },
    })),
  ];
  const reports = [];
  for (const entry of cases) {
    for (let i = 0; i < 20; i++) await entry.execute();
    await db.client.query("BEGIN; SET LOCAL track_functions='all'");
    const functionStats = async () =>
      (
        await db.client.query(
          'SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname=current_schema() ORDER BY funcname',
        )
      ).rows;
    const tableStats = async () =>
      (
        await db.client.query(
          'SELECT relname,seq_scan,seq_tup_read,idx_scan,idx_tup_fetch FROM pg_stat_xact_user_tables WHERE schemaname=current_schema() ORDER BY relname',
        )
      ).rows;
    const beforeFunctions = await functionStats(),
      beforeAccesses = await tableStats();
    const differences = (
      after: Record<string, unknown>[],
      before: Record<string, unknown>[],
      key: string,
    ) =>
      after.map((row) => {
        const previous = before.find((r) => r[key] === row[key]);
        const result: Record<string, unknown> = { [key]: row[key] };
        for (const field of Object.keys(row).filter((f) => f !== key)) {
          result[field] = Number(row[field] ?? 0) - Number(previous?.[field] ?? 0);
          assert(Number(result[field]) >= 0, 'Statistics reset during sample');
        }
        return result;
      });
    const samples = [];
    for (let i = 0; i < 200; i++) {
      const start = performance.now();
      await entry.execute();
      samples.push(performance.now() - start);
    }
    const functions = differences(await functionStats(), beforeFunctions, 'funcname').filter(
      (r) => Number(r.calls) > 0,
    );
    const accesses = differences(await tableStats(), beforeAccesses, 'relname').filter(
      (r) => Number(r.seq_scan) + Number(r.idx_scan) > 0,
    );
    await db.client.query('COMMIT');
    const sorted = [...samples].sort((a, b) => a - b);
    const report = {
      name: entry.name,
      p95: sorted[189],
      median: sorted[99],
      iterations: 200,
      functions,
      accesses,
      samples,
    };
    reports.push(report);
    console.log(JSON.stringify({ ...report, samples: 200 }));
  }
  const prepared = (
    await db.client.query(
      'SELECT name,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name',
    )
  ).rows;
  await writeFile(
    output,
    JSON.stringify(
      {
        at: new Date().toISOString(),
        power,
        freeBytes,
        query: captured.text,
        plan,
        nested,
        reports,
        prepared,
      },
      null,
      2,
    ) + '\n',
  );
} finally {
  await db.close();
}
