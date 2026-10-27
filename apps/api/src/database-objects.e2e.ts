import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { DatabaseObjectsController } from './modules/databases/database-objects.controller.ts';
import { DATABASE_QUOTA } from './modules/databases/database-quota.ts';
import { ACCESS_QUOTA } from './modules/workspaces/access-quota.ts';
import { throttleKey, ipKey } from '@memoria/auth';

await test('6b objects: live HTTP boundaries and atomic creation', async (t) => {
  process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
  process.env.DATABASE_ROWS_PER_BASE = '3';
  process.env.DATABASE_ROWS_PER_WORKSPACE = '6';
  process.env.DATABASE_PROPERTIES_PER_BASE = '10';
  process.env.DATABASE_OPTIONS_PER_PROPERTY = '3';
  const h = await databaseHttpFixture(),
    { f } = h;
  try {
    const owner = await h.account('owner'),
      guest = await h.account('guest'),
      outsider = await h.account('guest', false);
    const W = `/api/internal/workspaces/${f.db.workspace}/databases`,
      B = W + '/' + f.bases[0],
      P = B + '/properties/' + f.properties.text,
      R = B + '/rows/' + f.rows[0];
    const routes = [
      ['GET', W],
      ['POST', W],
      ['GET', B],
      ['PATCH', B],
      ['POST', B + '/properties'],
      ['PATCH', P],
      ['POST', P + '/options'],
      ['PATCH', P + '/options/' + f.options[0]],
      ['POST', B + '/rows'],
      ['GET', R],
      ['PATCH', R],
      ['GET', R + '/cells/' + f.properties.text],
      ['PATCH', R + '/cells/' + f.properties.text],
      ['POST', R + '/archive'],
      ['POST', R + '/restore'],
      ['GET', B + '/trash'],
      ['POST', P + '/choices'],
      ['GET', B + '/assignable-people'],
      ['PUT', B + '/assignable-people'],
    ] as const;
    await t.test(
      'D01 D02 D12: every mounted object method has a quota and refuses no session, bad Origin and hidden base',
      async () => {
        const proto = DatabaseObjectsController.prototype;
        for (const fn of Object.getOwnPropertyNames(proto).filter((k) => k.startsWith('route'))) {
          const handler = Reflect.get(proto, fn);
          assert(
            Reflect.getMetadata(DATABASE_QUOTA, handler) ||
              Reflect.getMetadata(ACCESS_QUOTA, handler),
          );
        }
        for (const [method, path] of routes) {
          assert.equal(
            (await h.call(undefined, {}, path, {}, method)).status,
            401,
            method + ' ' + path,
          );
          if (method !== 'GET')
            assert.equal(
              (await h.call(owner, {}, path, { origin: 'https://attacker.invalid' }, method))
                .status,
              403,
            );
        }
        for (const path of [B, R, R + '/cells/' + f.properties.text, B + '/assignable-people'])
          assert.equal((await h.call(outsider, {}, path, {}, 'GET')).status, 404, path);
        const list = await h.call(outsider, {}, W, {}, 'GET');
        assert.equal(list.status, 200);
        assert.deepEqual(list.data.databases, []);
      },
    );
    await t.test(
      'D03 D05 D06 D07: guest reads, cannot change schema or archive, hidden schema/persons stay hidden',
      async () => {
        const get = await h.call(guest, {}, B, {}, 'GET');
        assert.equal(get.status, 200);
        assert(!JSON.stringify(get.data).includes(f.bases[1]!));
        assert(!JSON.stringify(get.data).includes('@example.test'));
        for (const [method, path, body] of [
          ['POST', W, { title: 'forbidden' }],
          [
            'POST',
            B + '/properties',
            { expectedSchemaVersion: '1', name: 'Forbidden', kind: 'text' },
          ],
          ['PATCH', P, { expectedSchemaVersion: '1', name: 'Forbidden' }],
          [
            'POST',
            B + '/properties/' + f.properties.select + '/options',
            { expectedSchemaVersion: '1', label: 'Forbidden' },
          ],
          ['PATCH', B, { expectedSchemaVersion: '1', view: { filters: [], sorts: [] } }],
          ['POST', R + '/archive', { expectedVersion: '1' }],
          [
            'POST',
            B + '/rows',
            { receipt: randomUUID(), expectedSchemaVersion: '1', title: 'Forbidden' },
          ],
          [
            'PATCH',
            R + '/cells/' + f.properties.text,
            { expectedCellVersion: '0', expectedSchemaVersion: '1', value: 'forbidden' },
          ],
          ['PATCH', R, { expectedVersion: '1', title: 'Forbidden' }],
        ] as const) {
          assert.equal(
            (await h.call(guest, body, path, {}, method)).status,
            404,
            method + ' ' + path,
          );
        }
        const people = await h.call(
          guest,
          {},
          B + '/properties/' + f.properties.person + '/choices',
        );
        assert.equal(people.status, 200);
        assert(!JSON.stringify(people.data).includes(owner.user));
        assert(!JSON.stringify(people.data).includes('@example.test'));
        const relations = await h.call(
          guest,
          {},
          B + '/properties/' + f.properties.relation + '/choices',
        );
        assert.equal(relations.status, 200);
        assert.deepEqual(relations.data.items, []);
      },
    );
    let createdBase!: string, property!: string, createdRow!: string;
    await t.test(
      'D05 D08 D10: base/schema/options/view CAS, immutable populated definitions, quotas count trash',
      async () => {
        const create = await h.call(owner, { title: 'Tasks' }, W);
        assert.equal(create.status, 200, JSON.stringify(create.data));
        createdBase = String(create.data.id);
        const b = W + '/' + createdBase;
        const p = await h.call(
          owner,
          { expectedSchemaVersion: '1', name: 'Status', kind: 'select' },
          b + '/properties',
        );
        assert.equal(p.status, 200, JSON.stringify(p.data));
        property = String(p.data.id);
        assert.equal(
          (
            await h.call(
              owner,
              { expectedSchemaVersion: '1', name: 'stale' },
              b + '/properties/' + property,
              {},
              'PATCH',
            )
          ).status,
          409,
        );
        let schema = '2';
        const options: string[] = [];
        for (let n = 0; n < 3; n++) {
          const r = await h.call(
            owner,
            { expectedSchemaVersion: schema, label: 'Status ' + n },
            b + '/properties/' + property + '/options',
          );
          assert.equal(r.status, 200, JSON.stringify(r.data));
          schema = String(r.data.schemaVersion);
          options.push(String(r.data.id));
        }
        const archive = await h.call(
          owner,
          { expectedSchemaVersion: schema, archived: true },
          b + '/properties/' + property + '/options/' + options[0],
          {},
          'PATCH',
        );
        assert.equal(archive.status, 200);
        schema = String(archive.data.schemaVersion);
        const full = await h.call(
          owner,
          { expectedSchemaVersion: schema, label: 'Extra' },
          b + '/properties/' + property + '/options',
        );
        assert.equal(full.status, 409);
        assert.equal(full.data.code, 'DATABASE_CAPACITY_REACHED');
        const view = await h.call(
          owner,
          {
            expectedSchemaVersion: schema,
            view: { filters: [], sorts: [{ field: 'title', direction: 'asc' }] },
          },
          b,
          {},
          'PATCH',
        );
        assert.equal(view.status, 200);
        schema = String(view.data.schemaVersion);
        const receipt = randomUUID(),
          body = {
            receipt,
            title: 'Initial',
            expectedSchemaVersion: schema,
            values: [{ property, value: options[1] }],
          };
        const results = await Promise.all([
          h.call(owner, body, b + '/rows'),
          h.call(owner, body, b + '/rows'),
        ]);
        for (const r of results) assert.equal(r.status, 200, JSON.stringify(r.data));
        assert.equal(results[0]!.data.id, results[1]!.data.id);
        createdRow = String(results[0]!.data.id);
        assert.equal(
          (await h.call(owner, { ...body, title: 'Different' }, b + '/rows')).status,
          409,
        );
        const state = await f.db.pool.query(
          "SELECT (SELECT count(*) FROM collaboration_documents WHERE page_id=$1) docs,(SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND type='database.row.created') events",
          [createdRow],
        );
        assert.equal(state.rows[0].docs, '1');
        assert.equal(state.rows[0].events, '1');
        assert.equal(
          (
            await h.call(
              owner,
              { expectedSchemaVersion: schema, kind: 'number' },
              b + '/properties/' + property,
              {},
              'PATCH',
            )
          ).status,
          400,
        );
        const after = await h.call(owner, {}, b, {}, 'GET');
        assert.equal(after.data.schema_version, schema);
        const failRow = await h.call(
          owner,
          {
            receipt: randomUUID(),
            expectedSchemaVersion: schema,
            values: [{ property, value: randomUUID() }],
          },
          b + '/rows',
        );
        assert.equal(failRow.status, 400);
        const concurrent = await Promise.all(
          Array.from({ length: 4 }, () =>
            h.call(owner, { receipt: randomUUID(), expectedSchemaVersion: schema }, b + '/rows'),
          ),
        );
        assert.equal(
          concurrent.filter((x) => x.status === 200).length,
          1,
          JSON.stringify(concurrent.map((x) => x.data)),
        );
        assert(concurrent.filter((x) => x.status !== 200).every((x) => x.status === 409));
        assert.equal(
          (
            await f.db.pool.query(
              "SELECT used FROM database_counters WHERE workspace_id=$1 AND scope='rows'",
              [f.db.workspace],
            )
          ).rows[0].used,
          '6',
        );
        assert.equal(
          (
            await f.db.pool.query('SELECT count(*) FROM database_rows WHERE workspace_id=$1', [
              f.db.workspace,
            ])
          ).rows[0].count,
          '6',
        );
      },
    );
    await t.test(
      'D05: real cell CAS and independent title; lifecycle cannot free storage capacity',
      async () => {
        const b = W + '/' + createdBase,
          r = b + '/rows/' + createdRow;
        const schema = String((await h.call(owner, {}, b, {}, 'GET')).data.schema_version);
        const current = await h.call(owner, {}, r + '/cells/' + property, {}, 'GET');
        assert.equal(current.status, 200);
        const result = await h.call(
          owner,
          {
            expectedCellVersion: String(current.data.version),
            expectedSchemaVersion: schema,
            value: null,
          },
          r + '/cells/' + property,
          {},
          'PATCH',
        );
        assert.equal(result.status, 200, JSON.stringify(result.data));
        assert.equal(
          (
            await h.call(
              owner,
              {
                expectedCellVersion: String(current.data.version),
                expectedSchemaVersion: schema,
                value: null,
              },
              r + '/cells/' + property,
              {},
              'PATCH',
            )
          ).status,
          409,
        );
        const renamed = await h.call(
          owner,
          { expectedVersion: '1', title: 'Renamed' },
          r,
          {},
          'PATCH',
        );
        assert.equal(renamed.status, 200);
        assert.equal((await h.call(owner, { expectedVersion: '2' }, r + '/archive')).status, 200);
        assert.equal((await h.call(owner, {}, r, {}, 'GET')).status, 404);
        assert.equal(
          (
            await h.call(
              owner,
              { receipt: randomUUID(), expectedSchemaVersion: schema },
              b + '/rows',
            )
          ).status,
          409,
        );
        const trash = await h.call(owner, {}, b + '/trash', {}, 'GET');
        assert.equal(trash.status, 200);
        assert((trash.data.items as { id: string }[]).some((x) => x.id === createdRow));
        assert.equal((await h.call(owner, { expectedVersion: '3' }, r + '/restore')).status, 200);
        assert.equal((await h.call(owner, {}, r, {}, 'GET')).status, 200);
      },
    );
    await t.test(
      'D03 D06 D07: guest editing conserves hidden relations, controls nine types, and strong owner manages assignable people',
      async () => {
        await f.db.pool.query(
          "UPDATE access_grants SET level='edit' WHERE workspace_id=$1 AND subject_id IN(SELECT s.id FROM access_subjects s JOIN workspace_members m ON m.workspace_id=s.workspace_id AND m.id=s.member_id WHERE m.user_id=$2)",
          [f.db.workspace, guest.user],
        );
        const values: Record<string, unknown> = {
          text: 'textneedle',
          number: '-12.25',
          select: f.options.select![0],
          multi_select: [f.options.multi_select![0]],
          date: { start: '2026-10-27', end: null },
          checkbox: false,
          url: 'https://example.test/path',
          relation: { add: [f.rows[2]], remove: [] },
          person: { add: [], remove: [] },
        };
        for (const [kind, value] of Object.entries(values)) {
          const address = R + '/cells/' + f.properties[kind];
          const before = await h.call(owner, {}, address, {}, 'GET');
          assert.equal(before.status, 200);
          const write = await h.call(
            kind === 'relation' ? owner : guest,
            { expectedCellVersion: String(before.data.version), expectedSchemaVersion: '1', value },
            address,
            {},
            'PATCH',
          );
          assert.equal(write.status, 200, kind + ':' + JSON.stringify(write.data));
        }
        const address = R + '/cells/' + f.properties.relation,
          hidden = await h.call(guest, {}, address, {}, 'GET');
        assert.deepEqual(hidden.data.value, { items: [], hasHidden: true });
        assert(!JSON.stringify(hidden.data).includes(f.rows[2]!));
        const clear = await h.call(
          guest,
          {
            expectedCellVersion: String(hidden.data.version),
            expectedSchemaVersion: '1',
            value: { clearVisible: true },
          },
          address,
          {},
          'PATCH',
        );
        assert.equal(clear.status, 200, JSON.stringify(clear.data));
        assert.equal(
          (
            await f.db.pool.query(
              'SELECT count(*) FROM relation_values WHERE row_page_id=$1 AND target_page_id=$2 AND deleted_at IS NULL',
              [f.rows[0], f.rows[2]],
            )
          ).rows[0].count,
          '1',
        );
        const bad = await h.call(
          guest,
          {
            expectedCellVersion: String(clear.data.version),
            expectedSchemaVersion: '1',
            value: { remove: [f.rows[2]] },
          },
          address,
          {},
          'PATCH',
        );
        assert.equal(bad.status, 400);
        assert(!JSON.stringify(bad.data).includes(f.rows[2]!));
        for (const p of [P, B + '/properties/' + f.properties.select + '/options'])
          assert.equal(
            (
              await h.call(
                guest,
                { expectedSchemaVersion: '1', name: 'No', label: 'No' },
                p,
                {},
                p === P ? 'PATCH' : 'POST',
              )
            ).status,
            400,
          );
        const schema = String((await h.call(owner, {}, B, {}, 'GET')).data.schema_version);
        assert.equal(
          (
            await h.call(
              owner,
              { expectedSchemaVersion: schema, people: [] },
              B + '/assignable-people',
              {},
              'PUT',
            )
          ).status,
          403,
        );
        await h.prove(owner);
        const people = (
          await f.db.pool.query(
            'SELECT dp.id FROM database_people dp JOIN workspace_members m ON m.id=dp.member_id WHERE dp.workspace_id=$1 AND m.user_id=$2',
            [f.db.workspace, owner.user],
          )
        ).rows.map((r) => r.id);
        const allowed = await h.call(
          owner,
          { expectedSchemaVersion: schema, people },
          B + '/assignable-people',
          {},
          'PUT',
        );
        assert.equal(allowed.status, 200, JSON.stringify(allowed.data));
        const selector = await h.call(
          guest,
          {},
          B + '/properties/' + f.properties.person + '/choices',
        );
        assert.equal(selector.status, 200);
        assert(!JSON.stringify(selector.data).includes('@example.test'));
        assert((selector.data.items as { id: string }[]).some((p) => p.id === people[0]));
        assert.equal(
          (
            await h.call(
              guest,
              { expectedSchemaVersion: String(allowed.data.schemaVersion), people: [] },
              B + '/assignable-people',
              {},
              'PUT',
            )
          ).status,
          404,
        );
        // Free only a synthetic test row: positive guest creation remains bounded and has an initial Yjs body.
        await f.db.pool.query('DELETE FROM pages WHERE workspace_id=$1 AND id=$2', [
          f.db.workspace,
          f.rows[1],
        ]);
        const created = await h.call(
          guest,
          {
            receipt: randomUUID(),
            title: 'Guest task',
            expectedSchemaVersion: String(allowed.data.schemaVersion),
          },
          B + '/rows',
        );
        assert.equal(created.status, 200, JSON.stringify(created.data));
        const renamed = await h.call(
          guest,
          { expectedVersion: '1', title: 'Guest title' },
          B + '/rows/' + created.data.id,
          {},
          'PATCH',
        );
        assert.equal(renamed.status, 200);
      },
    );
    await t.test(
      'D12: each mutation family refuses forged IPs and alternate paths at the account and workspace budgets',
      async () => {
        for (const [family, path, method, max] of [
          ['E', R + '/cells/' + f.properties.text, 'PATCH', 120],
          ['C', B + '/rows', 'POST', 60],
          ['S', B + '/properties', 'POST', 30],
        ] as const) {
          const key = throttleKey(
            h.config.BETTER_AUTH_SECRET,
            `database:${family}:account`,
            owner.user + ':' + f.db.workspace,
          );
          await f.db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,$2,clock_timestamp(),clock_timestamp()) ON CONFLICT(key) DO UPDATE SET count=$2,started_at=clock_timestamp()',
            [key, max],
          );
          for (let n = 0; n < 2; n++) {
            const r = await h.call(
              owner,
              {},
              path.replace(String(f.bases[0]), n ? randomUUID() : String(f.bases[0])),
              { 'x-forwarded-for': `203.0.113.${n + 1}`, 'x-memoria-client-ip': '198.51.100.8' },
              method,
            );
            assert.equal(r.status, 429);
            assert.equal(r.data.code, 'DATABASE_RATE_LIMITED');
          }
          const ip = ipKey(h.config.BETTER_AUTH_SECRET, `database:${family}`, '127.0.0.1');
          await f.db.pool.query(
            'UPDATE auth_buckets SET count=$2,started_at=clock_timestamp() WHERE key=$1',
            [ip, family === 'E' ? 6000 : family === 'C' ? 3000 : 300],
          );
          assert.equal(
            (await h.call(guest, {}, path, { 'x-forwarded-for': '192.0.2.40' }, method)).status,
            429,
          );
        }
      },
    );
    await t.test(
      'D01 D04: restricted assurance, expiry and logout fail on every read family',
      async () => {
        await f.db.pool.query(
          "INSERT INTO session_assurance(session_id,method,verified_at) VALUES($1,'recovery',now())",
          [outsider.session],
        );
        for (const path of [W, B, R, R + '/cells/' + f.properties.text])
          assert.equal((await h.call(outsider, {}, path, {}, 'GET')).status, 403);
        await f.db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [outsider.session]);
        assert.equal((await h.call(outsider, {}, W, {}, 'GET')).status, 401);
      },
    );
  } finally {
    await h.close();
  }
});
