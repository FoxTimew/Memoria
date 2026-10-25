import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth } from '@memoria/auth';
import { cachePolicySchema } from '@memoria/contracts';
import { createDatabase } from '@memoria/db';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { ipKey } from '../../../packages/auth/src/throttle.ts';
import { testOtp } from '../../../packages/auth/src/testing/otp.ts';

await test(
  '4e real HTTP, PostgreSQL and cryptographic passkey cache policy',
  { timeout: 90000 },
  async (t) => {
    process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
    const db = await testDatabase();
    process.env.DATABASE_URL = db.url;
    const connection = createDatabase(db.url),
      config = readConfig();
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const password = 'test-only-cache-4e-password';
    const fixture = createAuth(connection.db, {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      sendVerificationEmail: async () => {},
    });
    function browser() {
      const jar = new Map<string, string>();
      return {
        async request(
          path: string,
          body?: unknown,
          method = body === undefined ? 'GET' : 'POST',
          shared?: boolean,
          extra: Record<string, string> = {},
        ) {
          const response = await fetch(
            origin + (path.startsWith('/api/') ? path : '/api/auth' + path),
            {
              method,
              headers: {
                Origin: config.APP_ORIGIN,
                'Content-Type': 'application/json',
                Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
                ...(shared === undefined ? {} : { 'x-memoria-shared-computer': String(shared) }),
                ...extra,
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          for (const cookie of response.headers.getSetCookie()) {
            const pair = cookie.split(';')[0]!,
              i = pair.indexOf('=');
            jar.set(pair.slice(0, i), pair.slice(i + 1));
          }
          return {
            status: response.status,
            data: (await response.json()) as Record<string, unknown>,
          };
        },
      };
    }
    type Browser = ReturnType<typeof browser>;
    async function ok(request: ReturnType<Browser['request']>, status = 200) {
      const result = await request;
      assert.equal(result.status, status, JSON.stringify(result.data));
      return result.data;
    }
    async function account(shared = false) {
      const email = randomUUID() + '@example.test';
      const created = await fixture.api.signUpEmail({
        body: { email, password, name: 'Cache test' },
      });
      await db.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [
        created.user.id,
      ]);
      const client = browser();
      await ok(client.request('/sign-in/email', { email, password }, 'POST', shared));
      return { id: created.user.id, email, client, key: testAuthenticator() };
    }
    async function policy(client: Browser) {
      return cachePolicySchema.parse(await ok(client.request('/security/cache-policy')));
    }
    async function prove(
      client: Browser,
      key: ReturnType<typeof testAuthenticator>,
      shared?: boolean,
    ) {
      const options = await ok(client.request('/passkey/generate-authenticate-options'));
      await ok(
        client.request(
          '/passkey/verify-authentication',
          { response: key.authenticate(String(options.challenge)) },
          'POST',
          shared,
        ),
      );
    }
    try {
      await t.test(
        'shared choice survives first TOTP enrollment and separate strong proof',
        async () => {
          const user = await account(true);
          const setup = await ok(user.client.request('/two-factor/enable', { password }));
          const otp = testOtp(String(setup.totpURI)),
            step = Math.floor(Date.now() / 30000);
          const initial = await policy(user.client);
          for (const n of [step - 1, step]) {
            const challenge = await ok(user.client.request('/security/challenge', {}));
            await ok(
              user.client.request(
                '/two-factor/verify-totp',
                { code: await otp.hotp(n) },
                'POST',
                false,
                { 'x-memoria-challenge': String(challenge.id) },
              ),
            );
            assert.equal((await policy(user.client)).sharedComputer, true);
          }
          assert.notEqual((await policy(user.client)).session, initial.session);
        },
      );
      const owner = await account(),
        member = await account(true),
        outsider = await account();
      const workspace = String(
        (
          await ok(
            owner.client.request('/api/internal/workspaces', {
              name: 'Cache policy',
              slug: 'cache-' + randomUUID(),
            }),
            201,
          )
        ).id,
      );
      const other = String(
        (
          await ok(
            owner.client.request('/api/internal/workspaces', {
              name: 'Other cache',
              slug: 'cache-' + randomUUID(),
            }),
            201,
          )
        ).id,
      );
      await db.pool.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        [workspace, member.id],
      );
      await db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        member.id,
      ]);
      const endpoint = `/api/internal/workspaces/${workspace}/security`;
      await t.test(
        'policy heartbeat has its own bounded NAT quota, not a credential allowance',
        async () => {
          const key = ipKey(config.BETTER_AUTH_SECRET, '/security/cache-policy', '127.0.0.1');
          await db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,3599,now(),now()) ON CONFLICT(key) DO UPDATE SET count=3599,started_at=now()',
            [key],
          );
          await policy(owner.client);
          assert.equal((await owner.client.request('/security/cache-policy')).status, 429);
          assert.equal((await owner.client.request('/security/status')).status, 200);
          await db.pool.query('DELETE FROM auth_buckets WHERE key=$1', [key]);
        },
      );
      await t.test(
        'anonymous denied; defaults allowed; shared choice stored on server; outsider sees no policies',
        async () => {
          assert.equal((await browser().request('/security/cache-policy')).status, 403);
          const ordinary = await policy(owner.client),
            shared = await policy(member.client);
          assert.equal(ordinary.sharedComputer, false);
          assert.equal(shared.sharedComputer, true);
          assert(ordinary.workspaces.every((p) => p.allowed && p.version === 1));
          assert.equal(shared.workspaces.length, 1);
          assert.equal((await policy(outsider.client)).workspaces.length, 0);
          assert.equal((await ok(member.client.request('/security/status'))).sharedComputer, true);
        },
      );
      const options = await ok(owner.client.request('/passkey/generate-register-options'));
      await ok(
        owner.client.request('/passkey/verify-registration', {
          response: owner.key.register(String(options.challenge)),
          name: 'Cache owner',
        }),
      );
      await prove(owner.client, owner.key);
      await t.test(
        'owner requires recent assurance, member denied, policy version fenced and other workspace preserved',
        async () => {
          const update = {
            expectedVersion: 1,
            requireStrongAuth: false,
            graceDays: 7,
            allowPersistentCache: false,
          };
          assert.equal((await member.client.request(endpoint, update, 'PUT')).status, 403);
          const changed = await ok(owner.client.request(endpoint, update, 'PUT'));
          assert.equal(changed.allowPersistentCache, false);
          assert.equal(changed.version, 2);
          assert.equal((await owner.client.request(endpoint, update, 'PUT')).status, 409);
          const p = await policy(owner.client);
          assert.equal(p.workspaces.find((w) => w.workspace === workspace)?.allowed, false);
          assert.equal(p.workspaces.find((w) => w.workspace === other)?.allowed, true);
          assert.equal((await policy(member.client)).workspaces[0]?.allowed, false);
          const audit = await db.pool.query(
            "SELECT metadata FROM audit_logs WHERE resource_id=$1 AND action='workspace.security.changed'",
            [workspace],
          );
          assert.equal(audit.rows[0].metadata.allowPersistentCache, false);
        },
      );
      await t.test(
        'anonymous passkey login persists shared choice and authenticated rotation cannot remove it',
        async () => {
          const login = browser();
          await prove(login, owner.key, true);
          const first = await policy(login);
          assert.equal(first.sharedComputer, true);
          await prove(login, owner.key, false);
          const next = await policy(login);
          assert.equal(next.sharedComputer, true);
          assert.notEqual(next.session, first.session);
          assert.equal(
            (await db.pool.query('SELECT 1 FROM auth_sessions WHERE id=$1', [first.session]))
              .rowCount,
            0,
          );
          const fresh = browser();
          await prove(fresh, owner.key);
          assert.equal((await policy(fresh)).sharedComputer, false);
        },
      );
      await t.test(
        'policy can re-enable only at a new version; old payload and expired assurance rejected',
        async () => {
          await ok(
            owner.client.request(
              endpoint,
              {
                expectedVersion: 2,
                requireStrongAuth: false,
                graceDays: 7,
                allowPersistentCache: true,
              },
              'PUT',
            ),
          );
          assert.equal(
            (await policy(owner.client)).workspaces.find((w) => w.workspace === workspace)?.version,
            3,
          );
          const current = await policy(owner.client);
          await db.pool.query(
            "UPDATE session_assurance SET verified_at=now()-interval '11 minutes' WHERE session_id=$1",
            [current.session],
          );
          assert.equal(
            (
              await owner.client.request(
                endpoint,
                {
                  expectedVersion: 3,
                  requireStrongAuth: false,
                  graceDays: 7,
                  allowPersistentCache: false,
                },
                'PUT',
              )
            ).status,
            403,
          );
          await ok(owner.client.request('/sign-out', {}));
          assert.equal((await owner.client.request('/security/cache-policy')).status, 403);
        },
      );
    } finally {
      await app.close();
      await connection.pool.end();
      await db.close();
    }
  },
);
