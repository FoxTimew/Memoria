import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { caddyFixture } from '../../collab/src/testing/caddy-fixture.ts';
import { nativeRowClient } from '../../collab/src/testing/native-row-client.ts';
import { until, firstText } from '../../collab/src/testing/pool-helpers.ts';
import { processDatabaseRowEvent, createDatabase } from '@memoria/db';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { fileURLToPath } from 'node:url';
import { collaborationRowAccessSchema } from '@memoria/contracts';
import { DatabaseAccessController } from './modules/databases/database-access.controller.ts';
import { DATABASE_QUOTA } from './modules/databases/database-quota.ts';
import { CONTENT_QUOTA } from './modules/pages/content-quota.ts';
import { attackRowCache } from './testing/row-cache-browser.ts';

if (process.argv.includes('--row-event-child')) {
  const c = createDatabase(process.env.DATABASE_URL!);
  try {
    await processDatabaseRowEvent(c.pool);
  } finally {
    await c.pool.end();
  }
  process.exit(0);
}

await test('6b native row protocol, effects and hostile HTTP/WSS clients', async (t) => {
  process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
  const h = await databaseHttpFixture(),
    { f } = h,
    owner = await h.account('owner'),
    guest = await h.account('guest'),
    outsider = await h.account('guest', false);
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      DATABASE_URL: f.db.url,
      COLLAB_HOST: '0.0.0.0',
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_VALIDATION_WORKERS: '1',
    }),
    f.db.pool,
    sessionVerifier(h.authentication),
  );
  const proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
  process.env.COLLAB_INTERNAL_URL = host.internal.url;
  const clients: Awaited<ReturnType<typeof nativeRowClient>>[] = [];
  const W = `/api/internal/workspaces/${f.db.workspace}`,
    B = W + '/databases/' + f.bases[0],
    R = B + '/rows/' + f.rows[0];
  const open = async (reader = owner, path = R) => {
    const r = await h.call(reader, {}, path + '/collaboration');
    assert.equal(r.status, 200, JSON.stringify(r.data));
    return collaborationRowAccessSchema.parse(r.data);
  };
  const connect = async (
    reader: typeof owner,
    meta: Awaited<ReturnType<typeof open>>,
    token: unknown = { ...meta.identity, scope: 'database-row', rowScope: meta.rowScope },
  ) => {
    const p = await nativeRowClient(
      proxy.url,
      proxy.ca,
      reader.cookie,
      h.config.APP_ORIGIN,
      meta.room,
      token,
    );
    clients.push(p);
    return p;
  };
  try {
    await t.test(
      'D01 D02 D11 D12: native routes authenticate, check Origin, declare quotas and hide unknown rows',
      async () => {
        for (const [name, method, path, body] of [
          ['access', 'POST', W + '/row-access', { rows: [] }],
          ['open', 'POST', R + '/collaboration', {}],
          ['write', 'PUT', R + '/content', {}],
        ] as const) {
          const handler = Reflect.get(DatabaseAccessController.prototype, name);
          assert(
            Reflect.getMetadata(DATABASE_QUOTA, handler) ||
              Reflect.getMetadata(CONTENT_QUOTA, handler),
          );
          assert.equal((await h.call(undefined, body, path, {}, method)).status, 401);
          assert.equal(
            (await h.call(owner, body, path, { origin: 'https://attacker.invalid' }, method))
              .status,
            403,
          );
        }
        assert.equal((await h.call(outsider, {}, R + '/collaboration')).status, 404);
        for (const reader of [guest, outsider]) {
          const response = await h.call(
            reader,
            {
              rows: [
                { database: f.bases[0], row: f.rows[0] },
                { database: f.bases[1], row: f.rows[2] },
                { database: f.bases[0], row: f.rows[2] },
                { database: randomUUID(), row: randomUUID() },
              ],
            },
            W + '/row-access',
          );
          assert.equal(response.status, 200);
          const rows = response.data.rows as { available: boolean }[];
          assert.deepEqual(
            rows.map((x) => x.available),
            [reader === guest, false, false, false],
          );
          assert(!JSON.stringify(response.data).includes('title'));
        }
        assert.equal(
          (
            await h.call(
              owner,
              {
                rows: Array.from({ length: 101 }, () => ({ database: f.bases[0], row: f.rows[0] })),
              },
              W + '/row-access',
            )
          ).status,
          400,
        );
      },
    );
    const meta = await open(),
      readerMeta = await open(guest),
      writer = await connect(owner, meta),
      reader = await connect(guest, readerMeta);
    assert(
      writer.provider.synced && reader.provider.synced && !writer.closed() && !reader.closed(),
    );
    await t.test(
      'D04: long workspace contention cannot starve leadership for append, open or projection',
      async () => {
        for (const operation of ['append', 'open', 'projection'] as const) {
          const blocker = await f.db.pool.connect();
          try {
            const lease = async () =>
              (await f.db.pool.query('SELECT lease_until FROM collaboration_leadership WHERE id=1'))
                .rows[0].lease_until as Date;
            const before = await lease();
            await blocker.query('BEGIN');
            await blocker.query('SELECT database_lock_workspace($1)', [f.db.workspace]);
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            let finished = false;
            const work =
              operation === 'append'
                ? writer.edit('contention ')
                : operation === 'open'
                  ? host.store.open({
                      key: 'blocked-open',
                      user: owner.user,
                      session: owner.session,
                      workspace: f.db.workspace,
                      page: f.containers[0]!,
                    })
                  : host.projections.project(f.rows[0]!, meta.room.split(':')[2]!);
            const outcome = work.then(
              (value) => {
                finished = true;
                return { value };
              },
              (error: unknown) => {
                finished = true;
                return { error };
              },
            );
            await until(
              async () =>
                (
                  await f.db.pool.query(
                    "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND wait_event_type='Lock'",
                    [pid],
                  )
                ).rowCount! > 0,
              'real workspace contention',
            );
            // Exceeds both the 1.5s control timeout and the 3s lease, without changing either.
            await delay(3300);
            assert(!finished, operation + ' remains behind the held barrier');
            assert((await lease()).getTime() > before.getTime() + 2500, 'leader actually renewed');
            assert(
              !writer.closed() && !reader.closed(),
              'unrelated native sockets remain connected',
            );
            await blocker.query('ROLLBACK');
            const result = await outcome;
            assert(!('error' in result), String('error' in result ? result.error : ''));
            if (operation === 'append')
              assert.equal(result.value, true, 'native durable receipt after release');
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        }
      },
    );
    await t.test(
      'D11: native row ticket converges, read-only cannot commit; old page scope, wrong base and identity fail',
      async () => {
        assert(await writer.edit('bodyneedle'));
        await until(
          () => firstText(reader.doc).toString().includes('bodyneedle'),
          'readonly convergence',
        );
        const before = (
          await f.db.pool.query(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
            [f.rows[0]],
          )
        ).rows[0].content_revision;
        // Bypass the UI and Hocuspocus read-only hint: actually transmit a client update.
        firstText(reader.doc).insert(0, 'forbidden');
        await until(() => reader.closed(), 'readonly malicious write closed');
        reader.close();
        assert.equal(
          (
            await f.db.pool.query(
              'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
              [f.rows[0]],
            )
          ).rows[0].content_revision,
          before,
        );
        for (const token of [
          '',
          { ...meta.identity, scope: 'page', accessVersion: meta.rowScope.baseVersion },
          {
            ...meta.identity,
            scope: 'database-row',
            rowScope: { ...meta.rowScope, database: f.bases[1] },
          },
          { ...meta.identity, user: guest.user, scope: 'database-row', rowScope: meta.rowScope },
        ]) {
          const denied = await connect(owner, meta, token);
          assert(denied.closed() && !denied.provider.synced);
          denied.close();
        }
      },
    );
    await t.test(
      'D06 D09: property search and Yjs projection share the index without leaking hidden rows',
      async () => {
        const cell = await h.call(
          owner,
          { expectedSchemaVersion: '1', expectedCellVersion: '0', value: 'textneedle' },
          R + '/cells/' + f.properties.text,
          {},
          'PATCH',
        );
        assert.equal(cell.status, 200, JSON.stringify(cell.data));
        await host.projections.project(f.rows[0]!, meta.generation);
        const search = async (reader: typeof owner, q: string) =>
          h.call(reader, {}, W + '/search?q=' + q, {}, 'GET');
        for (const q of ['bodyneedle', 'textneedle']) {
          const r = await search(guest, q);
          assert.equal(r.status, 200, JSON.stringify(r.data));
          assert(JSON.stringify(r.data).includes(f.rows[0]!));
          assert(!JSON.stringify((await search(outsider, q)).data).includes(f.rows[0]!));
        }
        assert.equal(
          (
            await f.db.pool.query(
              "SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND type='page.updated'",
              [f.rows[0]],
            )
          ).rows[0].count,
          '0',
        );
      },
    );
    await t.test(
      'D09: failed outbox transaction retains the window, retry groups authors once and emits no cell values',
      async () => {
        // Real PostgreSQL failure after insertion: audit failure must roll back the outbox and dirty clearing.
        await f.db.pool.query(
          "UPDATE database_row_changes SET last_dirty_at=now()-interval '2 seconds' WHERE row_page_id=$1",
          [f.rows[0]],
        );
        await f.db.pool.query(
          "CREATE FUNCTION test_row_audit_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='database.row.updated' THEN RAISE EXCEPTION 'injected outage'; END IF; RETURN NEW; END $$; CREATE TRIGGER test_row_audit_failure BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_row_audit_failure()",
        );
        await assert.rejects(() => processDatabaseRowEvent(f.db.pool));
        assert.equal(
          (
            await f.db.pool.query(
              "SELECT count(*) FROM outbox_events WHERE type='database.row.updated'",
              [],
            )
          ).rows[0].count,
          '0',
        );
        assert(
          (
            await f.db.pool.query(
              'SELECT first_dirty_at FROM database_row_changes WHERE row_page_id=$1',
              [f.rows[0]],
            )
          ).rows[0].first_dirty_at,
        );
        await f.db.pool.query(
          'DROP TRIGGER test_row_audit_failure ON audit_logs; DROP FUNCTION test_row_audit_failure()',
        );
        assert(await processDatabaseRowEvent(f.db.pool));
        assert.equal(await processDatabaseRowEvent(f.db.pool), false);
        const events = (
          await f.db.pool.query(
            "SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND type='database.row.updated'",
            [f.rows[0]],
          )
        ).rows;
        assert.equal(events.length, 1);
        assert(!JSON.stringify(events).includes('needle'));
        assert.equal(
          (
            await f.db.pool.query(
              "SELECT count(*) FROM audit_logs WHERE resource_id=$1 AND action='database.row.updated'",
              [f.rows[0]],
            )
          ).rows[0].count,
          '1',
        );
      },
    );
    await t.test(
      'D11: killed worker and concurrent flush retain every committed change',
      async () => {
        const address = R + '/cells/' + f.properties.text;
        const write = async (value: string) => {
          const current = await h.call(owner, {}, address, {}, 'GET');
          const r = await h.call(
            owner,
            {
              expectedSchemaVersion: '1',
              expectedCellVersion: String(current.data.version),
              value,
            },
            address,
            {},
            'PATCH',
          );
          assert.equal(r.status, 200, JSON.stringify(r.data));
        };
        const due = () =>
          f.db.pool.query(
            "UPDATE database_row_changes SET last_dirty_at=now()-interval '2 seconds' WHERE row_page_id=$1",
            [f.rows[0]],
          );
        const count = async () =>
          Number(
            (
              await f.db.pool.query(
                "SELECT count(*) FROM outbox_events WHERE aggregate_id=$1 AND type='database.row.updated'",
                [f.rows[0]],
              )
            ).rows[0].count,
          );
        await write('crashcanary');
        await due();
        const initial = await count();
        await f.db.pool.query(
          "CREATE FUNCTION test_slow_row_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='database.row.updated' THEN PERFORM pg_sleep(2); END IF; RETURN NEW; END $$; CREATE TRIGGER test_slow_row_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_slow_row_audit()",
        );
        const url = new URL(f.db.url);
        url.searchParams.set(
          'options',
          (url.searchParams.get('options') ?? '') + ' -c application_name=memoria_6b_event_crash',
        );
        const child = spawn(
            process.execPath,
            [fileURLToPath(import.meta.url), '--row-event-child'],
            {
              env: { ...process.env, DATABASE_URL: url.toString() },
              stdio: 'ignore',
              windowsHide: true,
            },
          ),
          exit = once(child, 'exit');
        try {
          await until(
            async () =>
              !!(
                await f.db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name='memoria_6b_event_crash' AND wait_event='PgSleep'",
                )
              ).rowCount,
            'worker inside uncommitted event',
          );
          child.kill();
          await exit;
          await until(
            async () =>
              !(
                await f.db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE application_name='memoria_6b_event_crash'",
                )
              ).rowCount,
            'database rolls back dead worker',
          );
        } finally {
          if (child.exitCode === null && child.signalCode === null) child.kill();
          await f.db.pool.query(
            'DROP TRIGGER test_slow_row_audit ON audit_logs; DROP FUNCTION test_slow_row_audit()',
          );
        }
        assert.equal(await count(), initial);
        assert(await processDatabaseRowEvent(f.db.pool));
        assert.equal(await count(), initial + 1);
        await write('flushcanary');
        await due();
        await f.db.pool.query(
          "CREATE FUNCTION test_slow_row_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='database.row.updated' THEN PERFORM pg_sleep(0.3); END IF; RETURN NEW; END $$; CREATE TRIGGER test_slow_row_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION test_slow_row_audit()",
        );
        const flush = processDatabaseRowEvent(f.db.pool);
        try {
          await until(
            async () =>
              !!(
                await f.db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE query LIKE 'INSERT INTO audit_logs%database_row_authors%' AND wait_event='PgSleep'",
                )
              ).rowCount,
            'flush holds revision row',
          );
          await Promise.all([flush, write('afterflushcanary')]);
        } finally {
          await flush;
          await f.db.pool.query(
            'DROP TRIGGER test_slow_row_audit ON audit_logs; DROP FUNCTION test_slow_row_audit()',
          );
        }
        await due();
        const race = await Promise.all([
          processDatabaseRowEvent(f.db.pool),
          processDatabaseRowEvent(f.db.pool),
        ]);
        assert.equal(race.filter(Boolean).length, 1);
        assert.equal(await count(), initial + 3);
        const events = (
          await f.db.pool.query(
            "SELECT payload FROM outbox_events WHERE aggregate_id=$1 AND type='database.row.updated' ORDER BY aggregate_version",
            [f.rows[0]],
          )
        ).rows;
        assert(!JSON.stringify(events).includes('canary'));
        assert.equal(new Set(events.map((e) => e.payload.eventRevision)).size, events.length);
      },
    );
    await t.test(
      'D11: non-editor row writes use HMAC/journal/projection and cannot escape their row',
      async () => {
        const doc = (await host.store.load(f.rows[0]!, meta.generation)).state;
        const first = (
          await f.db.pool.query(
            'SELECT id FROM blocks WHERE page_id=$1 ORDER BY position LIMIT 1',
            [f.rows[0]],
          )
        ).rows[0].id;
        const body = {
          generation: meta.generation,
          expectedRevision: Number(doc.content_revision),
          receipt: randomUUID(),
          operations: [
            {
              op: 'update',
              id: first,
              schemaVersion: 1,
              content: { spans: [{ type: 'text', text: 'commandneedle', styles: {} }] },
            },
          ],
        };
        assert.equal((await h.call(guest, body, R + '/content', {}, 'PUT')).status, 404);
        const done = await h.call(owner, body, R + '/content', {}, 'PUT');
        assert.equal(done.status, 200, JSON.stringify(done.data));
        await until(
          () => firstText(writer.doc).toString().includes('commandneedle'),
          'command broadcast',
        );
        assert(
          JSON.stringify(
            (await h.call(owner, {}, W + '/search?q=commandneedle', {}, 'GET')).data,
          ).includes(f.rows[0]!),
        );
        const replay = await h.call(owner, body, R + '/content', {}, 'PUT');
        assert.equal(replay.status, 200);
        assert.equal(replay.data.revision, done.data.revision);
        const forged = await fetch(host.internal.url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            action: 'open',
            workspace: f.db.workspace,
            page: f.rows[0],
            user: owner.user,
            session: owner.session,
            rowScope: meta.rowScope,
          }),
        });
        assert.equal(forged.status, 401);
      },
    );
    await t.test(
      'D11: archive closes only the row, stale lifecycle cannot reopen after restore, base reduction closes its rows',
      async () => {
        const otherMeta = await open(owner, B + '/rows/' + f.rows[1]),
          other = await connect(owner, otherMeta);
        const archived = await h.call(owner, { expectedVersion: '1' }, R + '/archive');
        assert.equal(archived.status, 200, JSON.stringify(archived.data));
        await until(() => writer.closed(), 'row archive closure');
        assert(!other.closed());
        assert.equal((await h.call(owner, {}, R + '/collaboration')).status, 404);
        assert.equal((await h.call(owner, { expectedVersion: '2' }, R + '/restore')).status, 200);
        const stale = await connect(owner, meta);
        assert(stale.closed() && !stale.provider.synced);
        const restored = await open(),
          live = await connect(owner, restored);
        assert(live.provider.synced);
        const guestLive = await connect(guest, await open(guest));
        assert(guestLive.provider.synced);
        await f.db.pool.query(
          'DELETE FROM access_grants WHERE workspace_id=$1 AND subject_id IN(SELECT s.id FROM access_subjects s JOIN workspace_members m ON m.workspace_id=s.workspace_id AND m.id=s.member_id WHERE s.workspace_id=$1 AND m.user_id=$2)',
          [f.db.workspace, guest.user],
        );
        await until(() => guestLive.closed(), 'base revocation');
        assert(!live.closed() && !other.closed());
        assert.equal((await h.call(guest, {}, R + '/collaboration')).status, 404);
        const revoked = await connect(guest, readerMeta);
        assert(revoked.closed());
      },
    );
    await t.test(
      'D11: Chromium cache with real HTTP decisions, sleeping tab, lifecycle and logout',
      async () => {
        await attackRowCache(h, owner);
      },
    );
    await t.test(
      'D04: recovery assurance and revoked session cannot open native rows or reconnect',
      async () => {
        const account = await h.account('member'),
          opened = await open(account),
          peer = await connect(account, opened);
        assert(peer.provider.synced);
        await f.db.pool.query(
          "INSERT INTO session_assurance(session_id,method,verified_at) VALUES($1,'recovery',now()) ON CONFLICT(session_id) DO UPDATE SET method='recovery',verified_at=now()",
          [account.session],
        );
        await until(() => peer.closed(), 'restricted session closes native row');
        peer.close();
        assert.equal((await h.call(account, {}, R + '/collaboration')).status, 403);
        assert.equal(
          (
            await h.call(
              account,
              { rows: [{ database: f.bases[0], row: f.rows[0] }] },
              W + '/row-access',
            )
          ).status,
          403,
        );
        const retry = await connect(account, opened);
        assert(retry.closed() && !retry.provider.synced);
        retry.close();
        await f.db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [account.session]);
        assert.equal((await h.call(account, {}, R + '/collaboration')).status, 401);
      },
    );
    await t.test(
      'D04: leadership lost while native writer waits still prevents the journal commit',
      async () => {
        const fresh = await open(),
          live = await connect(owner, fresh);
        const before = (
          await f.db.pool.query(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
            [f.rows[0]],
          )
        ).rows[0].content_revision;
        const blocker = await f.db.pool.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT database_lock_workspace($1)', [f.db.workspace]);
          const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
          const write = live.edit('must-not-commit');
          await until(
            async () =>
              (
                await f.db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%content_lock_document%'",
                  [pid],
                )
              ).rowCount! > 0,
            'writer waiting before leadership loss',
          );
          await f.db.pool.query('SELECT pg_terminate_backend($1)', [host.leadership.fence.pid]);
          await until(() => live.closed(), 'leadership failure closes native socket');
          await blocker.query('ROLLBACK');
          assert.equal(await write, false);
          await until(
            () => [...host.rooms.values()].every((room) => !room.pending),
            'failed journal drained',
          );
          assert.equal(
            (
              await f.db.pool.query(
                'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
                [f.rows[0]],
              )
            ).rows[0].content_revision,
            before,
          );
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
      },
    );
  } finally {
    for (const c of clients) c.close();
    proxy.close();
    await host.close();
    await h.close();
  }
});
