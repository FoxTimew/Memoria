import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { processAuthMail } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { authRoutes } from './modules/auth/auth.controller.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { testOtp } from '../../../packages/auth/src/testing/otp.ts';
import { ipKey, routeQuota } from '../../../packages/auth/src/throttle.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { securityPeer } from '../../collab/src/testing/security-peer.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { applyCommands } from '../../collab/src/service/commands.ts';
import { characterCardModel } from '../../../packages/blocks/character-card/src/model.ts';

// This route deliberately has no authentication decorator. It exists only in this executable.
@Controller('adversarial-default-guard')
class UnexpectedController {
  @Get()
  read() {
    return { leaked: true };
  }
}
@Module({ imports: [AppModule], controllers: [UnexpectedController] })
class AttackModule {}

async function until(check: () => boolean, label: string, milliseconds = 5000) {
  const end = Date.now() + milliseconds;
  while (!check()) {
    assert(Date.now() < end, `Attack observation timed out: ${label}`);
    await delay(20);
  }
}

await test(
  '4f attacker paths against actual Nest, Better Auth, PostgreSQL and WebSockets',
  { timeout: 180000 },
  async (t) => {
    process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
    const db = await testDatabase();
    process.env.DATABASE_URL = db.url;
    const connection = createDatabase(db.url),
      config = readConfig();
    const logs: string[] = [],
      errors: string[] = [],
      secrets = new Set<string>();
    const original = { log: console.log, warn: console.warn, error: console.error };
    const capture = (...values: unknown[]) =>
      logs.push(values.map((v) => (typeof v === 'string' ? v : JSON.stringify(v))).join(' '));
    console.log = console.warn = console.error = capture;
    const app = await NestFactory.create<NestExpressApplication>(AttackModule, {
      bodyParser: false,
      logger: { log: capture, warn: capture, error: capture, debug: capture, verbose: capture },
    });
    configureApplication(app);
    // Direct untrusted client: no forwarded header is an identity. The real Caddy path has a separate browser test.
    app.set('trust proxy', false);
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const host = await collaborationServer(
      readCollabConfig({ ...process.env, COLLAB_PORT: '0', COLLAB_INTERNAL_PORT: '0' }),
      db.pool,
      sessionVerifier(app.get(AuthService).auth),
    );
    process.env.COLLAB_INTERNAL_URL = host.internal.url;
    const peers: ReturnType<typeof securityPeer>[] = [];
    const password = randomBytes(24).toString('base64url');
    secrets.add(password);
    function client(cookie = '') {
      const jar = new Map(
        cookie
          ? cookie.split('; ').map((v) => {
              const i = v.indexOf('=');
              return [v.slice(0, i), v.slice(i + 1)];
            })
          : [],
      );
      return {
        cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        async request(
          path: string,
          body?: unknown,
          method = body === undefined ? 'GET' : 'POST',
          extra: Record<string, string> = {},
        ) {
          const response = await fetch(
            origin +
              (path.startsWith('/api/') || path.startsWith('/adversarial')
                ? path
                : '/api/auth' + path),
            {
              method,
              redirect: 'manual',
              headers: {
                Origin: config.APP_ORIGIN,
                'Content-Type': 'application/json',
                Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
                ...extra,
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          for (const c of response.headers.getSetCookie()) {
            const pair = c.split(';')[0]!,
              i = pair.indexOf('='),
              name = pair.slice(0, i),
              value = pair.slice(i + 1);
            if (!value || /Max-Age=0(?:;|$)/i.test(c)) jar.delete(name);
            else jar.set(name, value);
          }
          const text = await response.text();
          if (response.status >= 400) errors.push(text);
          let data: Record<string, unknown> = {};
          try {
            data = JSON.parse(text);
          } catch {
            /* Redirect or empty body. */
          }
          return { status: response.status, data, text, headers: response.headers };
        },
      };
    }
    type Client = ReturnType<typeof client>;
    async function ok(p: ReturnType<Client['request']>, status = 200) {
      const r = await p;
      // Never put a secret-bearing response body in an assertion/report.
      assert.equal(
        r.status,
        status,
        `Unexpected HTTP status; code=${String(r.data.code ?? 'none')}`,
      );
      return r.data;
    }
    async function account() {
      const email = randomUUID() + '@example.test',
        browser = client();
      const created = await ok(
        browser.request('/sign-up/email', { email, password, name: 'Adverse fixture' }),
      );
      const id = (created.user as { id: string }).id;
      await db.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [id]);
      await ok(browser.request('/sign-in/email', { email, password }));
      return { id, email, browser, key: testAuthenticator() };
    }
    async function enroll(b: Client, key: ReturnType<typeof testAuthenticator>) {
      const options = await ok(b.request('/passkey/generate-register-options'));
      const result = await ok(
        b.request('/passkey/verify-registration', {
          response: key.register(String(options.challenge)),
          name: 'Attack test key',
        }),
      );
      for (const code of (result.recoveryCodes as string[] | undefined) ?? []) secrets.add(code);
      return result.recoveryCodes as string[];
    }
    async function prove(b: Client, key: ReturnType<typeof testAuthenticator>) {
      const options = await ok(b.request('/passkey/generate-authenticate-options'));
      await ok(
        b.request('/passkey/verify-authentication', {
          response: key.authenticate(String(options.challenge)),
        }),
      );
    }
    async function blocked(
      b: Client,
      base: string,
      page: string,
      generation: string,
      restricted = false,
    ) {
      for (const path of [base + '/pages', base + '/pages/' + page])
        assert.equal((await b.request(path)).status, 403);
      assert.equal((await b.request(`${base}/pages/${page}/collaboration`, {})).status, 403);
      if (restricted) {
        // An attacker with a reset mailbox or a recovery-only cookie tries EVERY
        // session-5 facade, rather than relying on the original content guard test.
        const id = randomUUID();
        const routes: [string, string][] = [
          ['GET', base + '/invitations'],
          ['POST', base + '/invitations'],
          ['POST', base + `/invitations/${id}/resend`],
          ['POST', base + `/invitations/${id}/cancel`],
          ['GET', '/api/internal/invitations'],
          ['POST', '/api/internal/invitations/resolve'],
          ['POST', '/api/internal/invitations/accept'],
          ['POST', '/api/internal/invitations/reject'],
          ['GET', base + '/arrival'],
          ['GET', base + '/security'],
          ['PUT', base + '/security'],
          ['GET', base + '/members'],
          ['PUT', base + `/members/${id}/role`],
          ['DELETE', base + `/members/${id}`],
          ['GET', base + `/pages/${page}/shares`],
          ['PUT', base + `/pages/${page}/shares/${id}`],
          ['POST', base + `/pages/${page}/move/preview`],
          ['POST', base + `/pages/${page}/restore/preview`],
          ['GET', base + '/page-access'],
        ];
        for (const [method, path] of routes)
          assert.equal(
            (await b.request(path, method === 'GET' ? undefined : {}, method)).status,
            403,
            `${method} ${path}`,
          );
      }
      const workspace = base.split('/').at(-1)!;
      const p = securityPeer(
        host.ingress.url,
        `${workspace}:${page}:${generation}`,
        b.cookie(),
        config.APP_ORIGIN,
      );
      peers.push(p);
      await until(() => p.failed || p.closed, 'forbidden direct WebSocket');
      assert.equal(p.provider.isSynced, false);
    }
    const mails: { email: string; subject: string; text: string }[] = [];
    const mailOptions = {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      send: async (email: string, subject: string, text: string) => {
        mails.push({ email, subject, text });
      },
      report: capture,
    };
    async function drain() {
      for (let i = 0; i < 100 && (await processAuthMail(connection.db, mailOptions)); i++);
    }
    try {
      await t.test(
        'A01 default guard and all 27 exact public-facade routes enforce their IP quota before execution',
        async () => {
          assert.equal((await client().request('/adversarial-default-guard')).status, 401);
          const matrix = await readFile('docs/reviews/session-4-4f-routes.md', 'utf8');
          assert.equal(authRoutes.size, 27);
          for (const entry of authRoutes) {
            assert(
              matrix.includes('`' + entry + '`'),
              `Route missing from reviewed quota inventory: ${entry}`,
            );
            const [method, path] = entry.split(' ') as [string, string];
            const [limit, window] = routeQuota(path),
              key = ipKey(config.BETTER_AUTH_SECRET, path, '127.0.0.1');
            await db.pool.query(
              'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,$2,now(),now()) ON CONFLICT(key) DO UPDATE SET count=$2,started_at=now()',
              [key, limit],
            );
            const r = await client().request(path, method === 'POST' ? {} : undefined, method);
            assert.equal(r.status, 429, entry);
            assert(Number(r.headers.get('Retry-After')) <= window);
            await db.pool.query('DELETE FROM auth_buckets WHERE key=$1', [key]);
          }
        },
      );
      await t.test(
        'A02 unlisted native factor/recovery/organization routes, path and method aliases remain closed',
        async () => {
          for (const path of [
            '/two-factor/verify-backup-code',
            '/two-factor/generate-backup-codes',
            '/two-factor/send-otp',
            '/two-factor/verify-otp',
            '/request-password-reset',
            '/change-password',
            '/organization/update-member-role',
            '/organization/update',
            '/api-key/create',
            '/sign-in/email/',
            '/SIGN-IN/email',
            '/sign-in%2femail',
            '/security//recover',
          ]) {
            assert.equal(
              (await client().request(path, { password, trustDevice: true, newPassword: password }))
                .status,
              404,
              path,
            );
          }
          assert.equal((await client().request('/sign-in/email')).status, 404);
          assert.equal(
            (
              await client().request('/sign-in/email', {}, 'POST', {
                Origin: 'https://attacker.invalid',
              })
            ).status,
            403,
          );
        },
      );
      const victim = await account(),
        member = await account();
      const codes = await enroll(victim.browser, victim.key);
      await prove(victim.browser, victim.key);
      const workspace = String(
        (
          await ok(
            victim.browser.request('/api/internal/workspaces', {
              name: 'Adverse',
              slug: randomUUID(),
            }),
            201,
          )
        ).id,
      );
      const base = `/api/internal/workspaces/${workspace}`;
      await db.pool.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        [workspace, member.id],
      );
      await db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        member.id,
      ]);
      const page = String(
        (
          await ok(
            victim.browser.request(base + '/pages', { title: 'Unchanged', parentId: null }),
            201,
          )
        ).id,
      );
      const generation = String(
        (await ok(victim.browser.request(`${base}/pages/${page}/collaboration`, {}), 201))
          .generation,
      );
      await t.test(
        'A03 workspace policy cannot be bypassed with native routes or a direct collaborative connection',
        async () => {
          const live = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            member.browser.cookie(),
            config.APP_ORIGIN,
          );
          peers.push(live);
          await until(() => live.provider.isSynced, 'pre-policy socket');
          await ok(
            victim.browser.request(
              base + '/security',
              { expectedVersion: 1, requireStrongAuth: true, graceDays: 0 },
              'PUT',
            ),
          );
          await until(() => live.closed, 'policy revokes open socket');
          await blocked(member.browser, base, page, generation);
          assert.equal(
            (
              await member.browser.request('/organization/update-member-role', {
                organizationId: workspace,
                role: 'owner',
              })
            ).status,
            404,
          );
          assert.equal(
            (
              await member.browser.request(
                base + '/security',
                { expectedVersion: 2, requireStrongAuth: false, graceDays: 30 },
                'PUT',
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        'A04 mailbox-only password reset cannot retain assurance or bypass the second factor',
        async () => {
          const stolenCookie = victim.browser.cookie();
          const live = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            stolenCookie,
            config.APP_ORIGIN,
          );
          peers.push(live);
          await until(() => live.provider.isSynced, 'pre-reset socket');
          await ok(client().request('/security/request-password-reset', { email: victim.email }));
          await drain();
          const token = mails
            .filter((m) => m.email === victim.email)
            .map((m) => m.text.match(/#reset=([^\s]+)/)?.[1])
            .find(Boolean)!;
          assert(token, 'Reset email must be delivered by real outbox processor');
          secrets.add(token);
          const reset = client();
          await ok(
            reset.request('/reset-password', {
              token,
              newPassword: password,
              autoSignIn: true,
              twoFactorEnabled: false,
            }),
          );
          await until(() => live.closed, 'reset revokes socket');
          assert.equal((await client(stolenCookie).request('/security/status')).status, 403);
          assert.equal(
            (await client().request('/reset-password', { token, newPassword: password })).status,
            403,
          );
          await ok(
            reset.request('/sign-in/email', {
              email: victim.email,
              password,
              rememberDevice: true,
              trustDevice: true,
            }),
          );
          assert.equal((await ok(reset.request('/security/status'))).strong, false);
          await blocked(reset, base, page, generation, true);
          await ok(reset.request('/verify-password', { password }));
          assert.equal((await ok(reset.request('/security/status'))).strong, false);
          await blocked(reset, base, page, generation, true);
          assert.equal((await reset.request('/two-factor/disable', { password })).status, 403);
        },
      );
      await t.test(
        'A05 recovery session stays restricted through enrollment, native verification and finish; fresh proof is required',
        async () => {
          const limited = client();
          const challenge = await ok(
            limited.request('/security/recovery-challenge', {
              email: victim.email,
              purpose: 'code',
            }),
          );
          await ok(
            limited.request(
              '/security/recover',
              { email: victim.email, password, code: codes[0] },
              'POST',
              { 'x-memoria-recovery-challenge': String(challenge.id) },
            ),
          );
          await blocked(limited, base, page, generation, true);
          assert.equal((await limited.request('/security/recovery-finish', {})).status, 403);
          const replacement = testAuthenticator();
          await enroll(limited, replacement);
          const options = await ok(limited.request('/passkey/generate-authenticate-options'));
          assert.equal(
            (
              await limited.request('/passkey/verify-authentication', {
                response: replacement.authenticate(String(options.challenge)),
              })
            ).status,
            403,
          );
          await blocked(limited, base, page, generation, true);
          const restrictedCookie = limited.cookie();
          const finished = await ok(limited.request('/security/recovery-finish', {}));
          for (const code of finished.recoveryCodes as string[]) secrets.add(code);
          assert.equal((await client(restrictedCookie).request('/security/status')).status, 403);
          await blocked(limited, base, page, generation, true);
          assert.equal((await ok(limited.request('/security/status'))).strong, false);
          await prove(limited, replacement);
          await ok(limited.request(base + '/pages'));
          victim.browser = limited;
          victim.key = replacement;
        },
      );
      await t.test(
        'A06 forged identity/forwarding headers do not evade the real untrusted-peer quota',
        async () => {
          const key = ipKey(config.BETTER_AUTH_SECRET, '/sign-in/email', '127.0.0.1');
          await db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,150,now(),now()) ON CONFLICT(key) DO UPDATE SET count=150,started_at=now()',
            [key],
          );
          for (let i = 0; i < 8; i++) {
            const r = await client().request(
              '/sign-in/email',
              { email: victim.email, password },
              'POST',
              {
                'X-Forwarded-For': `203.0.113.${i + 1}`,
                'X-Real-IP': `198.51.100.${i + 1}`,
                Forwarded: `for=192.0.2.${i + 1}`,
                'X-Memoria-Client-IP': `2001:db8:${i}::1`,
                'x-user-id': victim.id,
              },
            );
            assert.equal(r.status, 429);
          }
          await db.pool.query('DELETE FROM auth_buckets WHERE key=$1', [key]);
        },
      );
      await t.test(
        'A07 HTTP TOTP enrollment and removal revoke actual WebSockets; pending enrollment never promotes',
        async () => {
          const live = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            victim.browser.cookie(),
            config.APP_ORIGIN,
          );
          peers.push(live);
          await until(() => live.provider.isSynced, 'pre-TOTP socket');
          const setup = await ok(victim.browser.request('/two-factor/enable', { password }));
          const uri = String(setup.totpURI),
            secret = new URL(uri).searchParams.get('secret')!;
          secrets.add(uri);
          secrets.add(secret);
          const otp = testOtp(uri),
            step = Math.floor(Date.now() / 30000),
            code = await otp.hotp(step - 1);
          secrets.add(code);
          const challenge = await ok(victim.browser.request('/security/challenge', {}));
          const verified = await ok(
            victim.browser.request('/two-factor/verify-totp', { code }, 'POST', {
              'x-memoria-challenge': String(challenge.id),
            }),
          );
          for (const c of (verified.recoveryCodes as string[] | undefined) ?? []) secrets.add(c);
          await until(() => live.closed, 'TOTP enrollment closes socket');
          assert.equal((await ok(victim.browser.request('/security/status'))).strong, false);
          await prove(victim.browser, victim.key);
          const second = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            victim.browser.cookie(),
            config.APP_ORIGIN,
          );
          peers.push(second);
          await until(() => second.provider.isSynced, 'pre-disable socket');
          await ok(victim.browser.request('/two-factor/disable', { password }));
          await until(() => second.closed, 'TOTP disable closes socket');
        },
      );
      await t.test(
        'A08 canary secrets absent from captured logs, audits, errors, metrics and non-dedicated mail channels',
        async () => {
          const marker = 'private-canary-' + randomBytes(16).toString('hex');
          secrets.add(marker);
          secrets.add(marker.slice(0, 10)); // JSON.parse errors can truncate a quoted input value.
          const writer = client();
          await prove(writer, victim.key);
          const invitationEmail = randomUUID() + '@example.test';
          const invitation = await ok(
            writer.request(base + '/invitations', {
              email: invitationEmail,
              role: 'guest',
              roots: [{ pageId: page, level: 'read' }],
            }),
            201,
          );
          // Error bodies must not echo arbitrary credentials smuggled into access mutations.
          await writer.request(
            `${base}/pages/${page}/shares/${randomUUID()}`,
            { expectedAccessVersion: 1, level: marker, password: marker },
            'PUT',
          );
          await writer.request(`${base}/pages/${page}/move/preview`, {
            expectedVersion: 1,
            parentId: marker,
            afterId: null,
          });
          // Session 6: seed private database content, then try to smuggle it into errors/logs.
          const database = await ok(writer.request(base + '/databases', { title: marker }));
          const databasePath = `${base}/databases/${String(database.id)}`;
          const property = await ok(
            writer.request(databasePath + '/properties', {
              expectedSchemaVersion: '1',
              name: marker,
              kind: 'text',
            }),
          );
          const databaseRow = await ok(
            writer.request(databasePath + '/rows', {
              receipt: randomUUID(),
              expectedSchemaVersion: '2',
              title: marker,
            }),
          );
          const cellPath = `${databasePath}/rows/${String(databaseRow.id)}/cells/${String(property.id)}`;
          await writer.request(databasePath + '/query', {
            filters: [{ field: marker, op: marker, value: marker }],
            sorts: [],
            password: marker,
          });
          await writer.request(databasePath + '/query', { filters: [], sorts: [], cursor: marker });
          await writer.request(
            cellPath,
            {
              expectedSchemaVersion: '2',
              expectedCellVersion: '0',
              value: marker,
              password: marker,
            },
            'PATCH',
          );
          secrets.add('private-database-sql-canary');
          await db.pool.query(
            "CREATE FUNCTION adverse_database_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-database-sql-canary'; END $$; CREATE TRIGGER adverse_database_failure BEFORE INSERT ON property_values FOR EACH ROW EXECUTE FUNCTION adverse_database_failure()",
          );
          try {
            const rejected = await writer.request(
              cellPath,
              { expectedSchemaVersion: '2', expectedCellVersion: '0', value: marker },
              'PATCH',
            );
            assert.equal(rejected.status, 500, 'Database failure path must actually execute');
          } finally {
            await db.pool.query(
              'DROP TRIGGER adverse_database_failure ON property_values; DROP FUNCTION adverse_database_failure()',
            );
          }
          await drain();
          assert(
            mails.some(
              (m) => m.email === invitationEmail && m.text.includes(String(invitation.id)),
            ),
            'Invitation delivered through real job processor',
          );
          const malicious = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            writer.cookie(),
            config.APP_ORIGIN,
          );
          peers.push(malicious);
          await until(() => malicious.provider.isSynced, 'leak probe socket');
          malicious.doc.transact(() => {
            applyCommands(malicious.doc, [
              {
                op: 'insert',
                id: randomUUID(),
                parentId: null,
                afterId: null,
                type: characterCardModel.type,
                schemaVersion: 2,
                content: characterCardModel.createDefault(),
              },
            ]);
            const group = malicious.doc.getXmlFragment('prosemirror').get(0);
            assert('get' in group);
            const container = group.get(0);
            assert('get' in container);
            const card = container.get(0);
            assert('setAttribute' in card);
            card.setAttribute('tags', marker);
          });
          await until(() => malicious.closed, 'malformed tag update rejected');
          assert.equal(malicious.reason, 'UPDATE_REJECTED');
          const invalidToken = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            writer.cookie(),
            config.APP_ORIGIN,
            marker,
          );
          peers.push(invalidToken);
          await until(() => invalidToken.failed, 'malformed authentication token rejected');
          assert.equal(invalidToken.reason, 'permission-denied');
          const invalidPresence = securityPeer(
            host.ingress.url,
            `${workspace}:${page}:${generation}`,
            writer.cookie(),
            config.APP_ORIGIN,
          );
          peers.push(invalidPresence);
          await until(() => invalidPresence.provider.isSynced, 'presence leak probe socket');
          invalidPresence.sendPresenceJson(marker);
          await until(() => invalidPresence.closed, 'malformed presence rejected');
          assert(
            !logs.join('\n').includes(marker.slice(0, 10)),
            'Presence parser leaked an input fragment; value deliberately suppressed',
          );
          assert(
            invalidPresence.reason === 'PRESENCE_INVALID_JSON',
            'Expected bounded ingress rejection; received ' +
              (invalidPresence.reason.match(/^[A-Z_]{1,40}$/)?.[0] ??
                'non-public reason suppressed'),
          );
          await client().request('/reset-password', { token: marker, newPassword: password });
          await client().request('/security/recover', {
            email: victim.email,
            password,
            code: marker,
          });
          await client().request('/sign-in/email', { email: victim.email, password: marker });
          await client().request('/passkey/verify-authentication', { response: { id: marker } });
          await client().request('/two-factor/verify-totp', {
            code: marker,
            secret: marker,
            totpURI: marker,
          });
          await ok(client().request('/security/request-password-reset', { email: victim.email }));
          await drain();
          const failureToken = mails
            .filter((m) => m.email === victim.email && m.text.includes('#reset='))
            .at(-1)!
            .text.match(/#reset=([^\s]+)/)![1]!;
          secrets.add(failureToken);
          await db.pool.query(
            "CREATE FUNCTION adverse_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'private-sql-canary'; END $$; CREATE TRIGGER adverse_failure BEFORE INSERT ON auth_security_events FOR EACH ROW EXECUTE FUNCTION adverse_failure()",
          );
          secrets.add('private-sql-canary');
          try {
            assert.equal(
              (
                await client().request('/reset-password', {
                  token: failureToken,
                  newPassword: password,
                })
              ).status,
              500,
            );
          } finally {
            await db.pool.query(
              'DROP TRIGGER adverse_failure ON auth_security_events; DROP FUNCTION adverse_failure()',
            );
          }
          await drain();
          await ok(client().request('/security/request-password-reset', { email: member.email }));
          let smtpFailed = false;
          const failedMailOptions = {
            ...mailOptions,
            send: async () => {
              smtpFailed = true;
              throw new Error(marker);
            },
          };
          for (let i = 0; i < 10 && (await processAuthMail(connection.db, failedMailOptions)); i++);
          assert(smtpFailed, 'SMTP failure path must actually execute');
          assert(logs.some((line) => line.includes('auth_mail_retry')));
          const audit =
            JSON.stringify((await db.pool.query('SELECT * FROM auth_security_events')).rows) +
            JSON.stringify((await db.pool.query('SELECT * FROM audit_logs')).rows) +
            JSON.stringify((await db.pool.query('SELECT * FROM outbox_events')).rows);
          const counters =
            JSON.stringify((await db.pool.query('SELECT * FROM auth_buckets')).rows) +
            JSON.stringify((await db.pool.query('SELECT * FROM auth_attempt_accounts')).rows);
          for (const [channel, text] of Object.entries({
            logs: logs.join('\n'),
            errors: errors.join('\n'),
            audit,
            counters,
          })) {
            for (const value of secrets)
              assert(
                !text.includes(value),
                `Secret leak detected in ${channel}; value deliberately suppressed`,
              );
          }
          for (const email of [victim.email, member.email, invitationEmail])
            assert(!counters.includes(email), 'Plaintext email in quota metrics');
          for (const mail of mails) {
            // Only the one-time reset/operator link is an accepted secret-bearing email channel.
            const withoutLink = mail.text.replace(/#(?:reset|operator)=[^\s]+/g, '#redacted');
            for (const value of secrets)
              assert(
                !(mail.subject + withoutLink).includes(value),
                'Unexpected secret in email; suppressed',
              );
          }
          const jobs = JSON.stringify((await db.pool.query('SELECT * FROM auth_mail_jobs')).rows);
          for (const value of [...secrets, victim.email, member.email, invitationEmail])
            assert(!jobs.includes(value), 'Unencrypted secret/email in durable mail queue');
          await writeFile(
            '.local/session-5d-leaks.json',
            JSON.stringify(
              {
                errorsInspected: errors.length,
                logEntriesInspected: logs.length,
                emailsInspected: mails.length,
                canaries: secrets.size,
                result:
                  'No canary leak in inspected channels; not an exhaustive information-flow proof',
              },
              null,
              2,
            ) + '\n',
          );
        },
      );
    } finally {
      for (const p of peers) p.destroy();
      await host.close();
      await app.close();
      await connection.pool.end();
      await db.close();
      Object.assign(console, original);
    }
  },
);
