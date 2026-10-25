import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Controller, Module, Param, Post } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth, requireSensitiveAction } from '@memoria/auth';
import type { SessionIdentity, SensitiveAction } from '@memoria/auth';
import { internalSignature } from '@memoria/auth/collaboration';
import { createDatabase } from '@memoria/db';
import { sql } from 'drizzle-orm';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { CurrentSession } from './modules/auth/current-user.decorator.ts';
import * as databaseModule from './database.module.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { securityPeer } from '../../collab/src/testing/security-peer.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';

// These contract endpoints exist only in this test executable. API keys and webhooks
// are future features; their shared gate is tested with an observable transactional effect.
@Controller('api/internal/security-contract/:workspace')
class SensitiveContract {
  constructor(private readonly database: databaseModule.DatabaseService) {}
  @Post(':action')
  run(
    @CurrentSession() session: SessionIdentity,
    @Param('workspace') workspace: string,
    @Param('action') action: SensitiveAction,
  ) {
    return this.database.db.transaction(async (tx) => {
      await requireSensitiveAction(tx, session, workspace, action);
      await tx.execute(sql`INSERT INTO test_sensitive_effects(action) VALUES(${action})`);
      return { status: 'ok' };
    });
  }
}
@Module({ imports: [AppModule], controllers: [SensitiveContract] })
class TestModule {}
async function until(predicate: () => boolean, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timeout: ' + label);
    await delay(15);
  }
}

await test(
  '4b: workspace policy, transactional gates and HTTP-to-WebSocket revocation',
  { timeout: 180000 },
  async (t) => {
    process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
    const db = await testDatabase();
    process.env.DATABASE_URL = db.url;
    const connection = createDatabase(db.url),
      config = readConfig();
    const app = await NestFactory.create<NestExpressApplication>(TestModule, {
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    app.set('trust proxy', 'loopback');
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const collabConfig = readCollabConfig({
      ...process.env,
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
    });
    const host = await collaborationServer(
      collabConfig,
      db.pool,
      sessionVerifier(app.get(AuthService).auth),
    );
    process.env.COLLAB_INTERNAL_URL = host.internal.url;
    const peers: ReturnType<typeof securityPeer>[] = [];
    const fixtureAuth = createAuth(connection.db, {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      sendVerificationEmail: async () => {},
    });
    const password = 'fixture-only-workspace-security-4b';
    let ip = 1;
    function client() {
      const jar = new Map<string, string>();
      return {
        cookie: () => [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        async request(path: string, body?: unknown, method = body === undefined ? 'GET' : 'POST') {
          const response = await fetch(
            origin + (path.startsWith('/api/') ? path : '/api/auth' + path),
            {
              method,
              headers: {
                'Content-Type': 'application/json',
                Origin: config.APP_ORIGIN,
                'x-forwarded-for': `2001:db8:${(ip++).toString(16)}::1`,
                Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0]!,
              separator = pair.indexOf('='),
              name = pair.slice(0, separator),
              value = pair.slice(separator + 1);
            if (!value || /Max-Age=0(?:;|$)/i.test(cookie)) jar.delete(name);
            else jar.set(name, value);
          }
          return {
            status: response.status,
            data: (await response.json()) as Record<string, unknown>,
          };
        },
      };
    }
    type Browser = ReturnType<typeof client>;
    async function ok(result: ReturnType<Browser['request']>, status = 200) {
      const r = await result;
      assert.equal(r.status, status, JSON.stringify(r.data));
      return r.data;
    }
    async function user() {
      const email = `${randomUUID()}@example.test`;
      const created = await fixtureAuth.api.signUpEmail({
        body: { email, name: 'Workspace security test', password },
      });
      await db.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [
        created.user.id,
      ]);
      const browser = client();
      await ok(browser.request('/sign-in/email', { email, password }));
      return { id: created.user.id, email, browser, key: testAuthenticator() };
    }
    async function sid(browser: Browser) {
      return (await ok(browser.request('/get-session'))).session as { id: string };
    }
    async function enroll(browser: Browser, key: ReturnType<typeof testAuthenticator>) {
      const options = await ok(browser.request('/passkey/generate-register-options'));
      await ok(
        browser.request('/passkey/verify-registration', {
          response: key.register(String(options.challenge)),
          name: 'Policy test key',
        }),
      );
    }
    async function prove(browser: Browser, key: ReturnType<typeof testAuthenticator>) {
      const options = await ok(browser.request('/passkey/generate-authenticate-options'));
      await ok(
        browser.request('/passkey/verify-authentication', {
          response: key.authenticate(String(options.challenge)),
        }),
      );
    }
    function peer(browser: Browser, workspace: string, page: string, generation: string) {
      const p = securityPeer(
        host.ingress.url,
        `${workspace}:${page}:${generation}`,
        browser.cookie(),
        config.APP_ORIGIN,
      );
      peers.push(p);
      return p;
    }
    try {
      await db.pool.query('CREATE TABLE test_sensitive_effects(action text NOT NULL)');
      const alice = await user(),
        bob = await user(),
        newcomer = await user(),
        outsider = await user();
      const create = async (slug: string) =>
        (
          await ok(
            alice.browser.request('/api/internal/workspaces', {
              name: 'Policy ' + slug,
              slug: 's4b-' + slug + '-' + randomUUID(),
            }),
            201,
          )
        ).id as string;
      const a = await create('protected'),
        b = await create('optional'),
        base = `/api/internal/workspaces/${a}`,
        other = `/api/internal/workspaces/${b}`;
      for (const w of [a, b]) {
        await db.pool.query(
          "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
          [w, bob.id],
        );
        await db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
          w,
          bob.id,
        ]);
      }
      const pageA = (
        await ok(
          alice.browser.request(base + '/pages', { title: 'Protected', parentId: null }),
          201,
        )
      ).id as string;
      const pageB = (
        await ok(
          alice.browser.request(other + '/pages', { title: 'Optional', parentId: null }),
          201,
        )
      ).id as string;
      const openedA = await ok(
        alice.browser.request(`${base}/pages/${pageA}/collaboration`, {}),
        201,
      );
      const openedB = await ok(
        alice.browser.request(`${other}/pages/${pageB}/collaboration`, {}),
        201,
      );
      const policy = async () => ok(alice.browser.request(base + '/security'));
      const update = async (required: boolean, days: number, version?: number) =>
        alice.browser.request(
          base + '/security',
          {
            requireStrongAuth: required,
            graceDays: days,
            expectedVersion: version ?? (await policy()).version,
          },
          'PUT',
        );
      const bobMember = (
        await db.pool.query(
          'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
          [a, bob.id],
        )
      ).rows[0].id as string;
      const aliceMember = (
        await db.pool.query(
          'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
          [a, alice.id],
        )
      ).rows[0].id as string;
      const deadline = async () =>
        String(
          (
            await db.pool.query('SELECT mfa_deadline FROM workspace_members WHERE id=$1', [
              bobMember,
            ])
          ).rows[0].mfa_deadline,
        );
      await t.test(
        'only an owner with a recent strong proof can manage policy; outsiders cannot inspect it',
        async () => {
          assert.equal((await update(true, 7)).status, 403);
          assert.equal(
            (
              await bob.browser.request(
                base + '/security',
                { requireStrongAuth: true, graceDays: 7, expectedVersion: 1 },
                'PUT',
              )
            ).status,
            403,
          );
          assert.equal((await outsider.browser.request(base + '/security')).status, 404);
          assert.equal((await policy()).requireStrongAuth, false);
        },
      );
      await t.test(
        'HTTP first-factor enrollment closes both live WebSockets, including the retained session, within five seconds',
        async () => {
          const second = client();
          await ok(second.request('/sign-in/email', { email: alice.email, password }));
          const one = peer(alice.browser, a, pageA, String(openedA.generation)),
            two = peer(second, a, pageA, String(openedA.generation));
          await until(() => one.provider.isSynced && two.provider.isSynced, 'initial live sockets');
          const start = Date.now();
          await enroll(alice.browser, alice.key);
          await until(
            () => one.closed && two.closed,
            'factor enrollment closes actual sockets',
            5000,
          );
          assert(Date.now() - start < 5000);
          assert.equal((await alice.browser.request(base + '/pages')).status, 403);
          assert.equal((await second.request(base + '/pages')).status, 401);
          await prove(alice.browser, alice.key);
          assert.equal((await alice.browser.request(base + '/pages')).status, 200);
        },
      );
      let graceDeadline = '';
      await t.test(
        'activation grants existing members seven days; edits and reactivation never postpone their deadline',
        async () => {
          await ok(update(true, 7));
          graceDeadline = await deadline();
          const delta = new Date(graceDeadline).getTime() - Date.now();
          assert(delta > 6.99 * 86400000 && delta <= 7 * 86400000);
          assert.equal((await bob.browser.request(base + '/pages')).status, 200);
          assert.equal((await bob.browser.request(other + '/pages')).status, 200);
          const version = Number((await policy()).version);
          await ok(update(true, 30));
          assert.equal(await deadline(), graceDeadline);
          assert.equal((await update(true, 7, version)).status, 409);
          assert.equal((await update(true, 31)).status, 400);
          await ok(update(false, 30));
          await ok(update(true, 30));
          assert.equal(await deadline(), graceDeadline);
        },
      );
      await t.test(
        'grace expiry closes only the protected workspace socket without a new SQL notification; HTTP/HMAC/reconnect fail closed',
        async () => {
          const restricted = peer(bob.browser, a, pageA, String(openedA.generation)),
            optional = peer(bob.browser, b, pageB, String(openedB.generation));
          await until(
            () => restricted.provider.isSynced && optional.provider.isSynced,
            'grace connections',
          );
          const expiry = Date.now() + 1200;
          await db.pool.query('UPDATE workspace_members SET mfa_deadline=$1 WHERE id=$2', [
            new Date(expiry),
            bobMember,
          ]);
          await delay(350);
          assert(!restricted.closed, 'grace must still permit access');
          await until(() => restricted.closed, 'time-only policy expiry', 6500);
          assert(Date.now() - expiry < 5000);
          assert(!optional.closed);
          for (const suffix of ['/pages', `/pages/${pageA}`, '/search?q=test'])
            assert.equal((await bob.browser.request(base + suffix)).status, 403);
          assert.equal(
            (
              await bob.browser.request(`${base}/pages/${pageA}/rename`, {
                title: 'Bypass',
                expectedVersion: 1,
              })
            ).status,
            403,
          );
          assert.equal(
            (await bob.browser.request(`${base}/pages/${pageA}/collaboration`, {})).status,
            403,
          );
          assert.equal(
            (await bob.browser.request(base + '/security')).status,
            200,
            'blocked members can see their deadline',
          );
          const before = (
            await db.pool.query(
              'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
              [pageA],
            )
          ).rows[0].content_revision;
          assert.equal(
            (
              await bob.browser.request(
                `${base}/pages/${pageA}/content`,
                {
                  generation: openedA.generation,
                  expectedRevision: openedA.contentRevision,
                  receipt: randomUUID(),
                  operations: [
                    {
                      op: 'insert',
                      id: randomUUID(),
                      parentId: null,
                      afterId: null,
                      type: 'core.paragraph',
                      schemaVersion: 1,
                      content: { spans: [] },
                    },
                  ],
                },
                'PUT',
              )
            ).status,
            403,
          );
          const body = JSON.stringify({
            action: 'open',
            session: (await sid(bob.browser)).id,
            user: bob.id,
            workspace: a,
            page: pageA,
          });
          const headers = internalSignature(
            collabConfig.COLLAB_INTERNAL_SECRET,
            '/internal/collaboration',
            body,
          );
          const direct = await fetch(host.internal.url, {
            method: 'POST',
            headers: { ...headers, 'Content-Type': 'application/json' },
            body,
          });
          assert.equal(direct.status, 403, await direct.text());
          const rejected = peer(bob.browser, a, pageA, String(openedA.generation));
          await until(() => rejected.failed || rejected.closed, 'reconnect refused');
          assert(!rejected.provider.isSynced);
          assert.equal(
            (
              await db.pool.query(
                'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
                [pageA],
              )
            ).rows[0].content_revision,
            before,
          );
          assert.equal((await bob.browser.request(other + '/pages')).status, 200);
          assert(!optional.closed);
        },
      );
      await t.test(
        'new members cannot inherit grace or supply a future deadline; missing deadline also denies access',
        async () => {
          await db.pool.query(
            "INSERT INTO workspace_members(workspace_id,user_id,role,mfa_deadline) VALUES($1,$2,'member',now()+interval '30 days')",
            [a, newcomer.id],
          );
          await db.pool.query(
            "INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')",
            [a, newcomer.id],
          );
          assert.equal((await newcomer.browser.request(base + '/pages')).status, 403);
          await db.pool.query(
            'UPDATE workspace_members SET mfa_deadline=NULL WHERE workspace_id=$1 AND user_id=$2',
            [a, newcomer.id],
          );
          assert.equal((await newcomer.browser.request(base + '/pages')).status, 403);
          await enroll(bob.browser, bob.key);
          await prove(bob.browser, bob.key);
          assert.equal((await bob.browser.request(base + '/pages')).status, 200);
          const restored = peer(bob.browser, a, pageA, String(openedA.generation));
          await until(() => restored.provider.isSynced, 'strong proof restores collaboration');
        },
      );
      await t.test(
        'recent assurance gates policy, roles and future API/webhook contracts; old assurance still allows content',
        async () => {
          const current = (await sid(alice.browser)).id;
          await db.pool.query(
            "UPDATE session_assurance SET verified_at=now()-interval '601 seconds' WHERE session_id=$1",
            [current],
          );
          assert.equal((await update(false, 7)).status, 403);
          assert.equal(
            (
              await alice.browser.request(
                `${base}/members/${bobMember}/role`,
                { expectedRole: 'member', role: 'owner' },
                'PUT',
              )
            ).status,
            403,
          );
          for (const action of ['api_key.create', 'webhook.create'])
            assert.equal(
              (await alice.browser.request(`/api/internal/security-contract/${a}/${action}`, {}))
                .status,
              403,
            );
          assert.equal((await alice.browser.request(base + '/pages')).status, 200);
          assert.equal((await db.pool.query('SELECT * FROM test_sensitive_effects')).rowCount, 0);
          await prove(alice.browser, alice.key);
          for (const action of ['api_key.create', 'webhook.create'])
            await ok(
              alice.browser.request(`/api/internal/security-contract/${a}/${action}`, {}),
              201,
            );
          await ok(
            bob.browser.request(`/api/internal/security-contract/${a}/api_key.create`, {}),
            201,
          );
          assert.equal(
            (await bob.browser.request(`/api/internal/security-contract/${a}/webhook.create`, {}))
              .status,
            403,
          );
          assert.equal((await db.pool.query('SELECT * FROM test_sensitive_effects')).rowCount, 3);
        },
      );
      await t.test(
        'assurance is rechecked after waiting for the workspace lock, before any sensitive effect',
        async () => {
          const blocker = await db.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [a]);
            const waiting = alice.browser.request(
              `/api/internal/security-contract/${a}/api_key.create`,
              {},
            );
            // Wait for the real request to queue behind the advisory lock, not a fixed sleep.
            const end = Date.now() + 5000;
            while (
              !(
                await db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock%' AND query NOT LIKE '%pg_stat_activity%' ",
                )
              ).rowCount
            ) {
              assert(Date.now() < end);
              await delay(20);
            }
            await db.pool.query(
              "UPDATE session_assurance SET verified_at=now()-interval '601 seconds' WHERE session_id=$1",
              [(await sid(alice.browser)).id],
            );
            await blocker.query('COMMIT');
            assert.equal((await waiting).status, 403);
            assert.equal((await db.pool.query('SELECT * FROM test_sensitive_effects')).rowCount, 3);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          await prove(alice.browser, alice.key);
        },
      );
      await t.test(
        'role mutations require owner + recent proof, compare the old role and preserve a last owner',
        async () => {
          const change = (browser: Browser, id: string, expectedRole: string, role: string) =>
            browser.request(`${base}/members/${id}/role`, { expectedRole, role }, 'PUT');
          assert.equal((await change(bob.browser, aliceMember, 'owner', 'member')).status, 403);
          assert.equal((await change(alice.browser, aliceMember, 'owner', 'member')).status, 409);
          const foreignMember = (
            await db.pool.query(
              'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
              [b, bob.id],
            )
          ).rows[0].id as string;
          assert.equal((await change(alice.browser, foreignMember, 'member', 'owner')).status, 404);
          await ok(change(alice.browser, bobMember, 'member', 'owner'));
          assert.equal((await change(alice.browser, bobMember, 'member', 'owner')).status, 409);
          await ok(change(alice.browser, bobMember, 'owner', 'member'));
          assert.equal(
            (
              await alice.browser.request('/organization/update-member-role', {
                memberId: bobMember,
                role: 'owner',
                organizationId: a,
              })
            ).status,
            404,
          );
        },
      );
      await t.test(
        'an audit failure rolls back policy, grace dates and version together',
        async () => {
          const before = await policy(),
            old = await deadline();
          await db.pool.query(
            "CREATE FUNCTION fail_test_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test audit unavailable'; END $$; CREATE TRIGGER fail_test_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_test_audit()",
          );
          try {
            assert.equal((await update(false, 7)).status, 500);
          } finally {
            await db.pool.query(
              'DROP TRIGGER fail_test_audit ON audit_logs; DROP FUNCTION fail_test_audit()',
            );
          }
          assert.deepEqual(await policy(), before);
          assert.equal(await deadline(), old);
        },
      );
      await t.test(
        'a concurrent policy activation wins before last-factor removal and rolls back no valid factor',
        async () => {
          await ok(update(false, 7));
          const factor = (
            await db.pool.query('SELECT id FROM auth_passkeys WHERE user_id=$1', [bob.id])
          ).rows[0].id as string;
          const blocker = await db.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              'UPDATE workspace_policies SET require_strong_auth=true WHERE workspace_id=$1',
              [a],
            );
            const removal = bob.browser.request('/passkey/delete-passkey', { id: factor });
            const end = Date.now() + 5000;
            while (
              !(
                await db.pool.query(
                  "SELECT 1 FROM pg_stat_activity WHERE wait_event='advisory' AND query LIKE '%pg_advisory_xact_lock_shared%' AND query NOT LIKE '%pg_stat_activity%' ",
                )
              ).rowCount
            ) {
              assert(Date.now() < end);
              await delay(20);
            }
            await blocker.query('COMMIT');
            const result = await removal;
            assert.equal(result.status, 403, JSON.stringify(result.data));
            assert.equal(result.data.code, 'LAST_FACTOR_REQUIRED');
            assert.equal(
              (await db.pool.query('SELECT 1 FROM auth_passkeys WHERE id=$1', [factor])).rowCount,
              1,
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
        },
      );
      await t.test(
        'HTTP activation without grace closes an existing weak socket and immediately blocks content',
        async () => {
          const workspace = await create('immediate'),
            path = `/api/internal/workspaces/${workspace}`;
          await db.pool.query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
            [workspace, newcomer.id],
          );
          await db.pool.query(
            "INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')",
            [workspace, newcomer.id],
          );
          const page = (
            await ok(
              alice.browser.request(path + '/pages', { title: 'Immediate', parentId: null }),
              201,
            )
          ).id as string;
          const opened = await ok(
            newcomer.browser.request(`${path}/pages/${page}/collaboration`, {}),
            201,
          );
          const live = peer(newcomer.browser, workspace, page, String(opened.generation));
          await until(() => live.provider.isSynced, 'weak socket before activation');
          const start = Date.now();
          await ok(
            alice.browser.request(
              path + '/security',
              { expectedVersion: 1, requireStrongAuth: true, graceDays: 0 },
              'PUT',
            ),
          );
          await until(() => live.closed, 'policy activation closes weak socket', 5000);
          assert(Date.now() - start < 5000);
          assert.equal((await newcomer.browser.request(path + '/pages')).status, 403);
        },
      );
      await t.test(
        'last-factor removal is refused by policy; HTTP removal with a spare factor closes actual sockets and revokes assurance',
        async () => {
          const first = (
            await db.pool.query('SELECT id FROM auth_passkeys WHERE user_id=$1', [alice.id])
          ).rows[0].id as string;
          assert.equal(
            (await alice.browser.request('/passkey/delete-passkey', { id: first })).status,
            403,
          );
          const spare = testAuthenticator();
          await enroll(alice.browser, spare);
          await prove(alice.browser, spare);
          const live = peer(alice.browser, a, pageA, String(openedA.generation));
          await until(() => live.provider.isSynced, 'socket before removal');
          const old = (await sid(alice.browser)).id,
            start = Date.now();
          await ok(alice.browser.request('/passkey/delete-passkey', { id: first }));
          await until(() => live.closed, 'HTTP removal disconnect', 5000);
          assert(Date.now() - start < 5000);
          assert.equal(
            (await db.pool.query('SELECT 1 FROM auth_sessions WHERE id=$1', [old])).rowCount,
            0,
          );
          assert.equal(
            (await db.pool.query('SELECT 1 FROM session_assurance WHERE session_id=$1', [old]))
              .rowCount,
            0,
          );
          assert.equal((await alice.browser.request(base + '/pages')).status, 401);
        },
      );
    } finally {
      for (const p of peers) p.destroy();
      await host.close();
      await app.close();
      await connection.pool.end();
      await db.close();
    }
  },
);
