import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { ipKey } from '@memoria/auth';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';

await test('6b table: executable attacks against the real Nest HTTP route', async (t) => {
  // The direct fixture connection is not a trusted proxy. Production uses the same config mechanism.
  process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
  const h = await databaseHttpFixture(),
    { f } = h;
  try {
    const owner = await h.account('owner'),
      guest = await h.account('guest'),
      outsider = await h.account('guest', false);
    const sorts = [
      { field: f.properties.number, direction: 'asc' },
      { field: f.properties.text, direction: 'asc' },
    ];
    for (const [row, n] of f.rows.slice(0, 2).map((r, i) => [r, i] as const)) {
      for (const [kind, value] of [
        ['text', n ? 'Other' : 'Literal % _ \\ <script>'],
        ['number', String(n + 1)],
        ['checkbox', n === 0],
        ['select', f.options.select![0]],
        ['multi_select', [f.options.multi_select![0]]],
        ['date', { start: '2026-10-27' }],
        ['url', 'https://example.test/x'],
      ] as const)
        await f.cells.write(f.owner, {
          ...f.address(kind, row),
          expectedCellVersion: '0',
          expectedSchemaVersion: '1',
          value,
        });
    }
    await f.cells.write(f.owner, {
      ...f.address('relation'),
      expectedCellVersion: '0',
      expectedSchemaVersion: '1',
      value: { add: [f.rows[2]] },
    });
    const hiddenPerson = (
      await f.db.pool.query<{ id: string }>(
        'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
        [f.db.workspace, owner.user],
      )
    ).rows[0]!.id;
    await f.cells.write(f.owner, {
      ...f.address('person'),
      expectedCellVersion: '0',
      expectedSchemaVersion: '1',
      value: { add: [hiddenPerson] },
    });
    await t.test('D01 D02: guard, Origin, inaccessible and cross-workspace IDs', async () => {
      assert.equal((await h.call(undefined)).status, 401);
      assert.equal(
        (await h.call(owner, {}, h.path(), { origin: 'https://hostile.test' })).status,
        403,
      );
      for (const route of [
        h.path(f.bases[1]),
        h.path(randomUUID()),
        h.path(f.bases[0], randomUUID()),
      ])
        assert.equal((await h.call(guest, {}, route)).status, 404);
      assert.equal((await h.call(outsider)).status, 404);
      assert.equal((await h.call(owner, {}, h.path(), {}, 'GET')).status, 404);
    });
    await t.test(
      'D06 D07: hidden values cannot be recovered through payload or filters',
      async () => {
        const r = await h.call(guest);
        assert.equal(r.status, 200);
        const encoded = JSON.stringify(r.data);
        for (const secret of [f.rows[2]!, f.bases[1]!, hiddenPerson, owner.user])
          assert(!encoded.includes(secret));
        assert(encoded.includes('"hasHidden":true'));
        for (const [field, values] of [
          [f.properties.relation, [f.rows[2], randomUUID()]],
          [f.properties.person, [hiddenPerson, randomUUID()]],
        ] as const) {
          let before: unknown;
          for (const value of values) {
            const refused = await h.call(guest, {
              filters: [{ field, op: 'any', value: [value] }],
            });
            assert.equal(refused.status, 400);
            if (before) assert.deepEqual(refused.data, before);
            before = refused.data;
          }
        }
        const empty = await h.call(guest, {
          filters: [{ field: f.properties.relation, op: 'empty' }],
        });
        assert.equal((empty.data.rows as unknown[]).length, 2);
        const notEmpty = await h.call(guest, {
          filters: [{ field: f.properties.relation, op: 'notEmpty' }],
        });
        assert.equal((notEmpty.data.rows as unknown[]).length, 0);
      },
    );
    await t.test('D08: typed operators, literal wildcards, injection and bounded AST', async () => {
      for (const [field, op, value, count] of [
        [f.properties.text, 'contains', '% _ \\', 1],
        [f.properties.number, 'between', ['1', '2'], 2],
        [f.properties.checkbox, 'eq', false, 1],
        [f.properties.date, 'eq', '2026-10-27', 2],
        [f.properties.select, 'in', [f.options.select![0]], 2],
        [f.properties.multi_select, 'any', [f.options.multi_select![0]], 2],
        [f.properties.url, 'startsWith', 'https://', 2],
      ] as const) {
        const r = await h.call(owner, { filters: [{ field, op, value }] });
        assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal((r.data.rows as unknown[]).length, count);
      }
      for (const body of [
        { sql: 'SELECT password' },
        { filters: [{ field: 'title); SELECT 1;--', op: 'eq', value: 'x' }] },
        { filters: [{ field: 'title', op: 'regex', value: '.*' }] },
        { filters: Array.from({ length: 11 }, () => ({ field: 'title', op: 'empty' })) },
        { filters: [{ field: f.properties.number, op: 'eq', value: 'NaN' }] },
        { filters: [{ field: f.properties.date, op: 'eq', value: '2026-02-30' }] },
        { sorts: [{ field: f.properties.relation, direction: 'asc' }] },
        { pageSize: 101 },
        { cursor: 'x', explain: true },
      ]) {
        const r = await h.call(owner, body);
        assert.equal(r.status, 400, JSON.stringify(r.data));
        assert(!JSON.stringify(r.data).includes('SELECT'));
      }
      assert.equal(
        (await h.call(owner, { filters: [{ field: 'title', op: 'eq', value: 'x'.repeat(17000) }] }))
          .status,
        413,
      );
      const r = await h.call(owner, {
        filters: [{ field: 'title', op: 'contains', value: "' OR true;--" }],
      });
      assert.equal(r.status, 200);
      assert.deepEqual(r.data.rows, []);
    });
    await t.test(
      'D09: signed cursor cannot cross actor, query, schema or revoked/regranted scope',
      async () => {
        const query = { sorts, pageSize: 1 };
        const first = await h.call(guest, query);
        assert.equal(first.status, 200);
        const cursor = String(first.data.cursor);
        const second = await h.call(guest, { ...query, cursor });
        assert.equal(second.status, 200);
        assert.notDeepEqual(first.data.rows, second.data.rows);
        for (const [actor, body] of [
          [owner, { ...query, cursor }],
          [guest, { ...query, cursor: cursor.slice(0, -8) + 'AAAAAAAA' }],
          [guest, { ...query, cursor, filters: [{ field: 'title', op: 'notEmpty' }] }],
        ] as const)
          assert.equal((await h.call(actor, body)).status, 409);
        await f.db.pool.query('UPDATE databases SET schema_version=schema_version+1 WHERE id=$1', [
          f.bases[0],
        ]);
        assert.equal((await h.call(guest, { ...query, cursor })).status, 409);
        const fresh = String((await h.call(guest, query)).data.cursor);
        await f.db.pool.query(
          'UPDATE access_grants SET deleted_at=now() WHERE subject_id IN(SELECT s.id FROM access_subjects s JOIN workspace_members m ON m.id=s.member_id WHERE m.user_id=$1)',
          [guest.user],
        );
        assert.equal((await h.call(guest, { ...query, cursor: fresh })).status, 404);
        await f.db.pool.query(
          'UPDATE access_grants SET deleted_at=NULL WHERE subject_id IN(SELECT s.id FROM access_subjects s JOIN workspace_members m ON m.id=s.member_id WHERE m.user_id=$1)',
          [guest.user],
        );
        assert.equal((await h.call(guest, { ...query, cursor: fresh })).status, 409);
      },
    );
    await t.test(
      'D01 D04: expired policy, restricted session and logout are enforced on table',
      async () => {
        await f.db.pool.query(
          "INSERT INTO workspace_policies(workspace_id,require_strong_auth,strong_auth_enabled_at,grace_days) VALUES($1,true,now()-interval '31 days',0) ON CONFLICT(workspace_id) DO UPDATE SET require_strong_auth=true,strong_auth_enabled_at=now()-interval '31 days',grace_days=0",
          [f.db.workspace],
        );
        assert.equal((await h.call(owner)).status, 404);
        await f.db.pool.query(
          'UPDATE workspace_policies SET require_strong_auth=false WHERE workspace_id=$1',
          [f.db.workspace],
        );
        await f.db.pool.query(
          "INSERT INTO session_assurance(session_id,method,verified_at) VALUES($1,'recovery',now()) ON CONFLICT(session_id) DO UPDATE SET method='recovery'",
          [guest.session],
        );
        assert.equal((await h.call(guest)).status, 403);
        await f.db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [guest.session]);
        assert.equal((await h.call(guest)).status, 401);
      },
    );
    await t.test(
      'D12: shared account bucket resists forged headers, identifiers and fixed-window extension',
      async () => {
        const key = h.accountBucket(owner);
        await f.db.pool.query(
          'UPDATE auth_buckets SET count=119,started_at=clock_timestamp() WHERE key=$1',
          [key],
        );
        assert.equal((await h.call(owner)).status, 200);
        const before = (
          await f.db.pool.query('SELECT started_at FROM auth_buckets WHERE key=$1', [key])
        ).rows[0].started_at;
        for (let n = 0; n < 3; n++) {
          const r = await h.call(owner, {}, h.path(randomUUID()), {
            'x-forwarded-for': `192.0.2.${n + 1}`,
            forwarded: 'for=198.51.100.5',
            'x-memoria-client-ip': '198.51.100.6',
          });
          assert.equal(r.status, 429);
          assert(r.headers.get('retry-after'));
          assert.equal(r.data.code, 'DATABASE_RATE_LIMITED');
        }
        assert.deepEqual(
          (await f.db.pool.query('SELECT started_at FROM auth_buckets WHERE key=$1', [key])).rows[0]
            .started_at,
          before,
        );
        const ip = ipKey(h.config.BETTER_AUTH_SECRET, 'database:L', '127.0.0.1');
        await f.db.pool.query(
          'UPDATE auth_buckets SET count=6000,started_at=clock_timestamp() WHERE key=$1',
          [ip],
        );
        assert.equal(
          (await h.call(outsider, {}, h.path(), { 'x-forwarded-for': '203.0.113.80' })).status,
          429,
        );
      },
    );
  } finally {
    await h.close();
  }
});
