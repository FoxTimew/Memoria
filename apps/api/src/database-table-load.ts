import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { prepareMeasurement, runMeasuredSeries } from '../../../scripts/measurement-memory.mjs';
import type { DatabaseQuery } from '@memoria/contracts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import type { Reader } from './testing/database-http-fixture.ts';
import { fillTableFixture, closedTableOracle } from './testing/database-table-fixture.ts';
import { queryFingerprint, signTableCursor } from './modules/databases/table-compiler.ts';
const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]!;
const preparation = await prepareMeasurement('database-http-table');
process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
const h = await databaseHttpFixture(),
  { f } = h;
const reports: unknown[] = [],
  plans: unknown[] = [],
  closedPlans: unknown[] = [];
let oracle: Awaited<ReturnType<typeof closedTableOracle>> | undefined;
try {
  const fixture = await fillTableFixture(f);
  // The authenticated guest readers replace the single synthetic guest from 6a.
  // Preserve exactly that guest's visible person set for every reader, including self.
  await f.db.pool.query(
    'INSERT INTO database_assignable_people(workspace_id,database_id,person_id) VALUES($1,$2,$3) ON CONFLICT DO NOTHING',
    [f.db.workspace, f.bases[0], f.guestMember],
  );
  const accounts: { owner: Reader[]; guest: Reader[] } = { owner: [], guest: [] };
  for (const role of ['owner', 'guest'] as const)
    for (let i = 0; i < 12; i++) accounts[role].push(await h.account(role));
  // No quotas disabled/reset/increased: all 24 authenticated readers use the same untrusted loopback IP.
  oracle = await closedTableOracle(
    { ...f, owner: accounts.owner[0]!, guest: accounts.guest[0]! },
    fixture.targetIds,
    closedPlans,
  );
  const choices = (
    await f.db.pool.query<{ id: string }>(
      'SELECT id FROM property_options WHERE property_id=$1 ORDER BY id LIMIT 20',
      [f.properties.select],
    )
  ).rows.map((r) => r.id);
  const save = () =>
    writeFile(
      '.local/session-6b-table-http-measurement.json',
      JSON.stringify(
        {
          fixture: {
            rows: 10000,
            properties: 50,
            pageSize: 50,
            readersPerRole: 12,
            ipCount: 1,
            personVisibility:
              '6a guest self plus original assignable set, shared identically by the 12 real guest readers',
          },
          protocol:
            '3 series x 200 HTTP requests per scenario; real global guard, quota/admission/compiler/serialization; server middleware through response finish and full HTTP round trip separately; exact 6a fixture/deep anchor offset 9000. Deep cursor provisioning uses trusted fixture SQL and production signing codec outside measured samples, never changes quota rows; hostile cursor tests are separate.',
          preparation,
          reports,
          plans,
          closedPlans,
        },
        null,
        2,
      ) + '\n',
    );
  for (const role of ['owner', 'guest'] as const) {
    let counter = 0;
    const reader = () => accounts[role][counter++ % 12]!;
    for (const scenario of ['broad', 'deep', 'ten-filters', 'nulls-desc']) {
      const filters: DatabaseQuery['filters'] =
        scenario === 'nulls-desc'
          ? []
          : [
              { field: f.properties.text!, op: 'contains', value: 'item' },
              { field: f.properties.number!, op: 'gte', value: '0' },
            ];
      if (scenario === 'ten-filters')
        filters.push(
          { field: f.properties.number!, op: 'lte', value: '200' },
          { field: f.properties.checkbox!, op: 'eq', value: true },
          { field: f.properties.select!, op: 'in', value: choices },
          { field: f.properties.date!, op: 'between', value: ['2026-01-01', '2026-12-31'] },
          { field: f.properties.url!, op: 'contains', value: '/' },
          { field: f.properties.multi_select!, op: 'notEmpty' },
          { field: f.properties.person!, op: 'notEmpty' },
          { field: f.properties.relation!, op: role === 'owner' ? 'notEmpty' : 'empty' },
        );
      const query: DatabaseQuery = {
        filters,
        sorts: [
          { field: f.properties.number!, direction: scenario === 'nulls-desc' ? 'desc' : 'asc' },
          { field: f.properties.text!, direction: 'asc' },
        ],
        pageSize: 50,
      };
      // Deep anchors are fixture data, provisioned outside samples with the production codec.
      // Every timed request still verifies its signature/scope and consumes the real quotas.
      const cursors = new Map<string, string>();
      let closedCursor: Awaited<ReturnType<typeof oracle.query>>['cursor'];
      if (scenario === 'deep') {
        closedCursor = (await oracle.query(role, 'broad', undefined, 9000)).cursor;
        assert(closedCursor);
        for (const account of accounts[role]) {
          const binding = (
            await f.db.pool.query<{ version: number; schema_version: string }>(
              'SELECT s.version,d.schema_version::text FROM databases d JOIN page_access_state s ON s.workspace_id=d.workspace_id AND s.page_id=d.page_id JOIN workspace_members m ON m.id=s.member_id WHERE d.id=$1 AND m.user_id=$2',
              [f.bases[0], account.user],
            )
          ).rows[0]!;
          const scope = createHash('sha256')
            .update(
              JSON.stringify([
                f.db.workspace,
                f.bases[0],
                account.user,
                account.session,
                binding.schema_version,
                binding.version,
                queryFingerprint(query),
              ]),
            )
            .digest('hex');
          cursors.set(
            account.user,
            signTableCursor(
              h.config.BETTER_AUTH_SECRET,
              scope,
              [closedCursor.number, closedCursor.text],
              closedCursor.id,
            ),
          );
        }
      }
      const expected = await oracle.query(role, scenario, closedCursor, 0, true);
      h.service.queryObserver = async (c, compiled) => {
        plans.push({
          role,
          scenario,
          sql: compiled.text,
          values: compiled.values,
          plan: (
            await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + compiled.text, compiled.values)
          ).rows,
        });
      };
      const first = accounts[role][0]!;
      const body = (a: Reader) => ({
        ...query,
        ...(cursors.has(a.user) ? { cursor: cursors.get(a.user)! } : {}),
      });
      const explained = await h.call(first, body(first));
      delete h.service.queryObserver;
      assert.equal(explained.status, 200, JSON.stringify(explained.data));
      assert.deepEqual(
        (explained.data.rows as { id: string }[]).map((r) => r.id),
        expected.ids,
        'general compiler and closed 6a oracle must select identical rows',
      );
      await save();
      const caseResults: { p95: number; httpP95: number }[] = [];
      for (let series = 1; series <= 3; series++) {
        const measured = await runMeasuredSeries(
          `database-http-${role}-${scenario}-${series}`,
          async () => {
            for (let n = 0; n < 3; n++) {
              const a = reader();
              const r = await h.call(a, body(a));
              assert.equal(r.status, 200);
            }
            const samples: number[] = [],
              roundTrips: number[] = [];
            for (let n = 0; n < 200; n++) {
              const a = reader(),
                r = await h.call(a, body(a));
              assert.equal(r.status, 200, JSON.stringify(r.data));
              assert(Number.isFinite(r.server));
              samples.push(r.server);
              roundTrips.push(r.roundTrip);
              if (role === 'guest')
                for (const id of fixture.targetIds) assert(!JSON.stringify(r.data).includes(id));
            }
            return { samples, roundTrips, p95: p95(samples), httpP95: p95(roundTrips) };
          },
          { preparation },
        );
        reports.push({ role, scenario, series, ...measured });
        caseResults.push(measured.result);
        await save();
        console.log(
          JSON.stringify({
            role,
            scenario,
            series,
            p95: measured.result.p95,
            httpP95: measured.result.httpP95,
            hygiene: measured.hygiene.path,
          }),
        );
      }
      const median = caseResults.map((r) => r.p95).sort((a, b) => a - b)[1]!;
      console.log(
        JSON.stringify({ role, scenario, medianP95: median, limit: 200, passed: median < 200 }),
      );
      assert(median < 200, 'STOP_6B_HTTP_TABLE_BUDGET');
    }
  }
} finally {
  oracle?.close();
  await h.close();
}
