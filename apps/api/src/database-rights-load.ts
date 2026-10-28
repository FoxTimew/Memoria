import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { readDatabaseLimits } from '@memoria/db';
import { prepareMeasurement, runMeasuredSeries } from '../../../scripts/measurement-memory.mjs';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { databaseLoadFixture } from '../../collab/src/testing/databases-fixture.ts';
import { databaseHttpHarness } from './testing/database-http-fixture.ts';
import { databaseLiveWriters } from './testing/database-live-writers.ts';
import { databaseEventWorker } from './testing/database-event-worker.ts';
import { profileDatabaseShare } from './testing/database-share-profile.ts';
import { databaseControlDiagnostic } from '../../collab/src/testing/database-control-diagnostic.ts';
import { profileDatabaseTree } from './testing/database-tree-profile.ts';

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;
const cases = [
  'share',
  'role',
  'remove',
  'move',
  'archive',
  'restore',
  'row-archive',
  'row-restore',
];
const fromCase = process.argv.includes('--from-case')
  ? process.argv[process.argv.indexOf('--from-case') + 1]
  : 'share';
assert(fromCase && cases.includes(fromCase), 'Unknown starting case');
const throughCase = process.argv.includes('--through-case')
  ? process.argv[process.argv.indexOf('--through-case') + 1]
  : cases.at(-1);
assert(throughCase && cases.includes(throughCase), 'Unknown ending case');
assert(cases.indexOf(throughCase) >= cases.indexOf(fromCase), 'Reversed case range');
const diagnostic = process.argv.includes('--diagnose-tree');
const selectedCases = diagnostic
  ? ['move']
  : cases.slice(cases.indexOf(fromCase), cases.indexOf(throughCase) + 1);
const preparation = await prepareMeasurement('database-http-rights');
const h = await databaseHttpHarness(async () => {
  // Bulk setup uses the same timeout as the 6a bound fixture; it is outside measured samples.
  const db = await testDatabase({ queryTimeoutMs: 120000 }),
    base = randomUUID(),
    row = randomUUID();
  await db.pool.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
    base,
    db.workspace,
    db.page,
  ]);
  await db.pool.query(
    "INSERT INTO pages(id,workspace_id,kind,position,title) VALUES($1,$2,'database_row','a0','Row')",
    [row, db.workspace],
  );
  await db.pool.query(
    'INSERT INTO database_rows(workspace_id,database_id,page_id) VALUES($1,$2,$3)',
    [db.workspace, base, row],
  );
  const fixture = await databaseLoadFixture(db, readDatabaseLimits());
  // Replace the synthetic owner with a genuine Better Auth account: exactly 100 memberships.
  await db.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
    db.workspace,
    db.user,
  ]);
  return { db, bases: fixture.bases, containers: [db.page], fixture };
});
const { db, bases, fixture } = h.f,
  w = db.workspace;
const owner = await h.account('owner');
const W = `/api/internal/workspaces/${w}`;
const selected = (
  await db.pool.query(
    "SELECT m.* FROM workspace_members m WHERE workspace_id=$1 AND role='guest' ORDER BY id LIMIT 1",
    [w],
  )
).rows[0];
const subject = (
  await db.pool.query('SELECT * FROM access_subjects WHERE workspace_id=$1 AND member_id=$2', [
    w,
    selected.id,
  ])
).rows[0];
const grants = (
  await db.pool.query('SELECT * FROM access_grants WHERE workspace_id=$1 AND subject_id=$2', [
    w,
    subject.id,
  ])
).rows;
const shared = (
  await db.pool.query(
    `SELECT g.resource_id FROM access_grants g
     JOIN databases d ON d.workspace_id=g.workspace_id AND d.page_id=g.resource_id
     JOIN pages p ON p.id=d.page_id AND p.parent_id IS NULL
     WHERE g.subject_id=$1 ORDER BY g.resource_id LIMIT 1`,
    [subject.id],
  )
).rows[0].resource_id as string;
const subtree = (
  await db.pool.query<{ id: string }>(
    'WITH RECURSIVE t AS (SELECT id FROM pages WHERE id=$1 UNION ALL SELECT p.id FROM pages p JOIN t ON p.parent_id=t.id) SELECT id FROM t',
    [fixture.tree.root],
  )
).rows.map((r) => r.id);
const writerRoutes: string[] = [];
for (const base of bases.slice(0, 4)) {
  const row = (
    await db.pool.query(
      'SELECT page_id FROM database_rows WHERE database_id=$1 ORDER BY page_id LIMIT 1',
      [base],
    )
  ).rows[0].page_id;
  writerRoutes.push(`${W}/databases/${base}/rows/${row}`);
}
writerRoutes.push(`${W}/pages/${db.page}`);
const targetRow = (
  await db.pool.query(
    'SELECT page_id FROM database_rows WHERE database_id=$1 ORDER BY page_id LIMIT 1',
    [bases[45]],
  )
).rows[0].page_id as string;
const rowPath = `${W}/databases/${bases[45]}/rows/${targetRow}`;
const reports: unknown[] = [];
const events = databaseEventWorker(db.pool);
const finishDiagnostic = diagnostic ? databaseControlDiagnostic(db.pool) : undefined;
const save = () =>
  writeFile(
    '.local/session-6d-http-rights.json',
    JSON.stringify(
      {
        fixture: {
          ordinary: 1000,
          bases: 50,
          rows: 50000,
          members: 100,
          grants: 5000,
          shareTarget: 'root container; no inherited edit can mask its read/edit transition',
          subtree: subtree.length,
          properties: 'empty; rights cardinality, not table workload',
        },
        protocol:
          'Three series/case; 32 HTTP mutations with two explicit warmups, one genuine owner with recent WebAuthn. Five native WSS documents (four rows in different bases and one ordinary page), paced 5 updates/s. Setup/reset and fresh previews outside measured writer windows. 2150ms between mutations respects unchanged per-account access quotas. Lock waits sampled every 5ms (approximate), wire time ends at durable receipt. Retain blocked-wait p95 and overlapping editor confirmations separately from all confirmations.',
        preparation,
        selectedCases,
        reports,
      },
      null,
      2,
    ) + '\n',
  );
const restoreMember = async () => {
  const c = await db.pool.connect();
  try {
    await c.query('BEGIN');
    // Isolated fixture reset, outside measured writer windows. A real rejoin gets
    // a NEW member/person ID; this benchmark restores its original generated ID.
    // The rights fixture contains no assignments, so only its unreferenced,
    // detached person can be removed. Never change the production detach trigger.
    await c.query(
      `DELETE FROM database_people p WHERE p.workspace_id=$1 AND p.id=$2 AND p.member_id IS NULL
       AND NOT EXISTS(SELECT 1 FROM person_values v WHERE v.workspace_id=p.workspace_id AND v.member_id=p.id)`,
      [w, selected.id],
    );
    await c.query(
      "INSERT INTO workspace_members SELECT * FROM json_populate_record(NULL::workspace_members,$1::json) ON CONFLICT(id) DO UPDATE SET role='guest'",
      [JSON.stringify(selected)],
    );
    await c.query(
      'INSERT INTO access_subjects SELECT * FROM json_populate_record(NULL::access_subjects,$1::json) ON CONFLICT(id) DO UPDATE SET deleted_at=NULL',
      [JSON.stringify(subject)],
    );
    await c.query('DELETE FROM access_grants WHERE subject_id=$1', [subject.id]);
    await c.query(
      'INSERT INTO access_grants SELECT * FROM json_populate_recordset(NULL::access_grants,$1::json)',
      [JSON.stringify(grants)],
    );
    await c.query('COMMIT');
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
};
try {
  if (process.argv.includes('--profile-tree')) {
    await profileDatabaseTree(h, owner, preparation, fixture.tree);
  } else if (process.argv.includes('--tree-preflight')) {
    await h.prove(owner);
    const value = (
      await db.pool.query('SELECT version FROM pages WHERE id=$1', [fixture.tree.root])
    ).rows[0].version;
    const route = `${W}/pages/${fixture.tree.root}/move/preview`;
    const input = { expectedVersion: value, parentId: fixture.tree.destination, afterId: null };
    const rejected = await h.call(owner, input, route);
    assert.equal(typeof value, 'string', 'raw pg bigint differs from Drizzle number mapping');
    assert.equal(rejected.status, 400);
    const accepted = await h.call(owner, { ...input, expectedVersion: Number(value) }, route);
    assert.equal(accepted.status, 201);
    console.log(
      JSON.stringify({
        preflight: 'ordinary page version contract',
        rawType: typeof value,
        rejected: rejected.status,
        accepted: accepted.status,
        affectedPages: accepted.data.pages,
      }),
    );
  } else if (
    process.argv.includes('--profile') ||
    process.argv.includes('--profile-role') ||
    process.argv.includes('--profile-remove')
  ) {
    await profileDatabaseShare(
      h,
      owner,
      shared,
      selected.id as string,
      preparation,
      process.argv.includes('--profile-remove')
        ? { kind: 'remove', reset: restoreMember }
        : process.argv.includes('--profile-role')
          ? { kind: 'role', reset: restoreMember }
          : undefined,
    );
  } else
    for (const kind of selectedCases) {
      for (let series = 1; series <= (diagnostic ? 1 : 3); series++) {
        const eventStart = events.count();
        await restoreMember();
        await h.prove(owner);
        const writers = await databaseLiveWriters(h, owner, writerRoutes);
        try {
          const { result, hygiene } = await runMeasuredSeries(
            `database-http-rights-${kind}-${series}`,
            async () => {
              const mutations: { server: number; roundTrip: number; start: number; end: number }[] =
                  [],
                waits: number[] = [],
                wire: number[] = [],
                overlap: number[] = [],
                confirmations: number[] = [],
                previews: number[] = [];
              let failure: string | null = null;
              for (let n = 0; n < (diagnostic ? 1 : 32) && !failure; n++) {
                const cycle = performance.now();
                let path = '',
                  method = 'POST',
                  body: Record<string, unknown> = {};
                if (['role', 'remove'].includes(kind)) {
                  await restoreMember();
                  path = `${W}/members/${selected.id}` + (kind === 'role' ? '/role' : '');
                  method = kind === 'role' ? 'PUT' : 'DELETE';
                  body = { expectedRole: 'guest', ...(kind === 'role' ? { role: 'member' } : {}) };
                } else if (kind === 'share') {
                  const state = await h.call(owner, {}, `${W}/pages/${shared}/shares`, {}, 'GET');
                  assert.equal(state.status, 200);
                  path = `${W}/pages/${shared}/shares/${selected.id}`;
                  method = 'PUT';
                  body = {
                    expectedAccessVersion: state.data.accessVersion,
                    level: n % 2 ? 'edit' : 'read',
                  };
                } else if (kind.startsWith('row-')) {
                  // Reset this single synthetic row outside the editor window, preserve unrelated scopes.
                  await db.pool.query(
                    'UPDATE database_rows SET deleted_at=' +
                      (kind === 'row-restore' ? 'now()' : 'NULL') +
                      ' WHERE page_id=$1',
                    [targetRow],
                  );
                  await db.pool.query(
                    'UPDATE pages SET deleted_at=' +
                      (kind === 'row-restore' ? 'now()' : 'NULL') +
                      ' WHERE id=$1',
                    [targetRow],
                  );
                  const r = (
                    await db.pool.query('SELECT version FROM pages WHERE id=$1', [targetRow])
                  ).rows[0];
                  path = rowPath + '/' + kind.slice(4);
                  body = { expectedVersion: String(r.version) };
                } else {
                  await db.pool.query('UPDATE pages SET deleted_at=NULL WHERE id=ANY($1::uuid[])', [
                    subtree,
                  ]);
                  await db.pool.query('UPDATE pages SET parent_id=$1 WHERE id=$2', [
                    fixture.tree.parent,
                    fixture.tree.root,
                  ]);
                  if (kind === 'restore')
                    await db.pool.query(
                      'UPDATE pages SET deleted_at=now() WHERE id=ANY($1::uuid[])',
                      [subtree],
                    );
                  const page = (
                    await db.pool.query('SELECT version FROM pages WHERE id=$1', [
                      fixture.tree.root,
                    ])
                  ).rows[0];
                  path = `${W}/pages/${fixture.tree.root}/${kind}`;
                  body = {
                    expectedVersion: Number(page.version),
                    ...(kind === 'move'
                      ? { parentId: fixture.tree.destination, afterId: null }
                      : {}),
                  };
                  if (kind !== 'archive') {
                    const preview = await h.call(owner, body, path + '/preview');
                    assert(
                      preview.status >= 200 && preview.status < 300,
                      `Preview HTTP_${preview.status}_${String(preview.data.code)}`,
                    );
                    previews.push(preview.server);
                    body.previewToken = preview.data.token;
                  }
                }
                let mutation!: { server: number; roundTrip: number; start: number; end: number };
                const editors = await writers.run(async () => {
                  const start = performance.now();
                  const r = await h.call(owner, body, path, {}, method);
                  mutation = {
                    start,
                    end: performance.now(),
                    server: r.server,
                    roundTrip: r.roundTrip,
                  };
                  if (diagnostic)
                    console.log(
                      JSON.stringify({
                        diagnosticMutation: kind,
                        status: r.status,
                        serverMs: r.server,
                      }),
                    );
                  if (r.status < 200 || r.status >= 300)
                    failure = `HTTP_${r.status}_${String(r.data.code)}`;
                  await delay(450);
                }, 5);
                if (kind === 'share' && !failure) {
                  const effective = await db.pool.query(
                    'SELECT level FROM page_access_state WHERE workspace_id=$1 AND member_id=$2 AND page_id=$3',
                    [w, selected.id, shared],
                  );
                  assert.equal(
                    effective.rows[0]?.level,
                    body.level,
                    'share changes effective access',
                  );
                }
                if (n >= 2) {
                  mutations.push(mutation);
                  waits.push(...editors.waits);
                  wire.push(...editors.wire.map((r) => r.ms));
                  confirmations.push(...editors.confirmations);
                  overlap.push(
                    ...editors.wire
                      .filter((r) => r.start <= mutation.end && r.end >= mutation.start)
                      .map((r) => r.ms),
                  );
                }
                await delay(Math.max(0, 2150 - (performance.now() - cycle)));
              }
              return {
                failure,
                mutations,
                waits,
                wire,
                overlap,
                confirmations,
                previews,
                p95: {
                  mutation: p95(mutations.map((r) => r.server)),
                  blockedSqlWait: p95(waits),
                  wire: p95(wire),
                  overlappingWire: p95(overlap),
                  serverConfirmation: p95(confirmations),
                },
              };
            },
            { preparation },
          );
          events.check();
          assert(!diagnostic, 'Diagnostic samples must not be published as qualification p95');
          reports.push({
            kind,
            series,
            hygiene,
            ...result,
            aggregatedEvents: events.count() - eventStart,
          });
          await save();
          console.log(
            JSON.stringify({
              kind,
              series,
              p95: result.p95,
              overlap: result.overlap.length,
              failure: result.failure,
            }),
          );
          assert(!result.failure, result.failure ?? '');
          assert(
            result.p95.mutation < 500 &&
              result.p95.blockedSqlWait < 100 &&
              Math.max(result.p95.wire, result.p95.overlappingWire) < 200,
            'STOP_DATABASE_HTTP_RIGHTS_BUDGET',
          );
        } finally {
          await writers.close();
        }
      }
    }
} finally {
  await finishDiagnostic?.();
  await events.close();
  await h.close();
}
