import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { testOtp } from '../../../packages/auth/src/testing/otp.ts';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth, processAuthMail, operatorReset } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { securityPeer } from '../../collab/src/testing/security-peer.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';

async function until(predicate: () => boolean, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!predicate()) {
    if (Date.now() > end) throw new Error('Timeout: ' + label);
    await delay(15);
  }
}

await test(
  '4c: recovery, atomicity and operator reset over real HTTP/SQL/WebSocket',
  { timeout: 240000 },
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
    function client(cookie = '') {
      const jar = new Map<string, string>(
        cookie
          ? cookie.split('; ').map((v) => {
              const i = v.indexOf('=');
              return [v.slice(0, i), v.slice(i + 1)];
            })
          : [],
      );
      return {
        cookie: () => [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
        async request(
          path: string,
          body?: unknown,
          method = body === undefined ? 'GET' : 'POST',
          extra: Record<string, string> = {},
        ) {
          const response = await fetch(
            origin + (path.startsWith('/api/') ? path : '/api/auth' + path),
            {
              method,
              headers: {
                'Content-Type': 'application/json',
                Origin: config.APP_ORIGIN,
                'x-forwarded-for': `2001:db8:${(ip++).toString(16)}::1`,
                Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
                ...extra,
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
      return ok(
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
    const mails: { email: string; subject: string; text: string }[] = [];
    const mailOptions = {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      send: async (email: string, subject: string, text: string) => {
        mails.push({ email, subject, text });
      },
    };
    async function drain() {
      for (let n = 0; n < 100 && (await processAuthMail(connection.db, mailOptions)); n++);
    }
    async function resetToken(email: string) {
      await ok(client().request('/security/request-password-reset', { email }));
      await drain();
      const token = mails
        .filter((m) => m.email === email && m.text.includes('#reset='))
        .at(-1)
        ?.text.match(/#reset=([^\s]+)/)?.[1];
      assert(token);
      return token;
    }
    async function room(browser: Browser) {
      const w = await ok(
        browser.request('/api/internal/workspaces', { name: 'Recovery test', slug: randomUUID() }),
        201,
      );
      const base = `/api/internal/workspaces/${w.id}`;
      const p = await ok(
        browser.request(base + '/pages', { title: 'Recovery test', parentId: null }),
        201,
      );
      const open = await ok(browser.request(`${base}/pages/${p.id}/collaboration`, {}), 201);
      return {
        base,
        workspace: String(w.id),
        page: String(p.id),
        generation: String(open.generation),
      };
    }
    try {
      const alice = await user();
      const codes = (await enroll(alice.browser, alice.key)).recoveryCodes as string[];
      await prove(alice.browser, alice.key);
      const r = await room(alice.browser);
      await ok(
        alice.browser.request(
          r.base + '/security',
          { requireStrongAuth: true, graceDays: 0, expectedVersion: 1 },
          'PUT',
        ),
      );
      const oldSession = (await sid(alice.browser)).id;
      let token = '';
      await t.test(
        'generic queued email for known, unknown and unverified accounts; hashed 30-minute token',
        async () => {
          const unverified = `${randomUUID()}@example.test`;
          await fixtureAuth.api.signUpEmail({
            body: { email: unverified, name: 'Unverified', password },
          });
          const a = await ok(
            client().request('/security/request-password-reset', { email: alice.email }),
          );
          for (const email of [unverified, `${randomUUID()}@example.test`])
            assert.deepEqual(
              await ok(client().request('/security/request-password-reset', { email })),
              a,
            );
          assert.equal(mails.length, 0);
          const queued = await db.pool.query('SELECT payload FROM auth_mail_jobs');
          assert.equal(queued.rowCount, 3);
          assert(queued.rows.every((row) => !row.payload.includes('@example.test')));
          await drain();
          assert.equal(mails.length, 1);
          token = mails[0]!.text.match(/#reset=([^\s]+)/)![1]!;
          const grant = (
            await db.pool.query(
              'SELECT identifier,expires_at FROM auth_verifications WHERE value=$1',
              [alice.id],
            )
          ).rows;
          assert(
            grant.some(
              (g) => Math.abs(new Date(g.expires_at).getTime() - Date.now() - 1800000) < 10000,
            ),
          );
          assert(grant.every((g) => !g.identifier.includes(token)));
          assert.equal((await sid(alice.browser)).id, oldSession);
        },
      );
      await t.test(
        'invalid/expired tokens and weak password refuse without changing sessions or factors',
        async () => {
          assert.equal(
            (await client().request('/reset-password', { token: 'bad', newPassword: password }))
              .status,
            403,
          );
          assert.equal(
            (await client().request('/reset-password', { token, newPassword: 'short' })).status,
            400,
          );
          assert.equal(
            (await client().request('/reset-password?token=' + token, { newPassword: password }))
              .status,
            403,
          );
          assert.equal(
            (await client().request('/request-password-reset', { email: alice.email })).status,
            404,
          );
          const expired = await resetToken(alice.email);
          await db.pool.query(
            "UPDATE auth_verifications SET expires_at=now()-interval '1 second' WHERE value=$1",
            [alice.id],
          );
          assert.equal(
            (await client().request('/reset-password', { token: expired, newPassword: password }))
              .status,
            403,
          );
          token = await resetToken(alice.email);
          assert.equal((await sid(alice.browser)).id, oldSession);
        },
      );
      await t.test(
        'injected SQL failure rolls back password, token, assurance and session; no success cookie',
        async () => {
          await db.pool.query(
            "CREATE FUNCTION fail_reset_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='password_reset' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_reset BEFORE INSERT ON auth_security_events FOR EACH ROW EXECUTE FUNCTION fail_reset_audit()",
          );
          try {
            assert.equal(
              (await client().request('/reset-password', { token, newPassword: password + '-new' }))
                .status,
              500,
            );
          } finally {
            await db.pool.query(
              'DROP TRIGGER fail_reset ON auth_security_events; DROP FUNCTION fail_reset_audit()',
            );
          }
          await ok(client().request('/sign-in/email', { email: alice.email, password }));
          assert.equal((await sid(alice.browser)).id, oldSession);
          assert.equal((await ok(alice.browser.request('/security/status'))).strong, true);
        },
      );
      await t.test(
        'concurrent reset has one winner, closes real socket, retains factors/policy and requires new strong proof',
        async () => {
          const live = peer(alice.browser, r.workspace, r.page, r.generation);
          await until(() => live.provider.isSynced, 'reset socket');
          const results = await Promise.all(
            [1, 2].map(() =>
              client().request('/reset-password', { token, newPassword: password + '-new' }),
            ),
          );
          assert.equal(results.filter((x) => x.status === 200).length, 1);
          assert(results.some((x) => x.status >= 400));
          await until(() => live.closed, 'reset closes socket', 5000);
          assert.equal((await alice.browser.request(r.base + '/pages')).status, 401);
          assert.equal(
            (
              await db.pool.query('SELECT 1 FROM session_assurance WHERE session_id=$1', [
                oldSession,
              ])
            ).rowCount,
            0,
          );
          assert.equal(
            (await db.pool.query('SELECT 1 FROM auth_passkeys WHERE user_id=$1', [alice.id]))
              .rowCount,
            1,
          );
          assert.equal(
            (
              await db.pool.query(
                'SELECT require_strong_auth FROM workspace_policies WHERE workspace_id=$1',
                [r.workspace],
              )
            ).rows[0].require_strong_auth,
            true,
          );
          const b = client();
          await ok(
            b.request('/sign-in/email', { email: alice.email, password: password + '-new' }),
          );
          assert.equal((await b.request(r.base + '/pages')).status, 403);
          assert.equal((await b.request('/passkey/generate-register-options')).status, 403);
          await prove(b, alice.key);
          await ok(b.request(r.base + '/pages'));
          alice.browser = b;
          await drain();
          assert(
            mails.some(
              (m) => m.email === alice.email && m.text.includes('mot de passe a été réinitialisé'),
            ),
          );
        },
      );
      let recovery = client();
      await t.test(
        'password plus single-use code; concurrent one winner, actual socket revoked, recovery cannot read even optional workspace',
        async () => {
          const optional = await room(alice.browser);
          const live = peer(alice.browser, r.workspace, r.page, r.generation);
          await until(() => live.provider.isSynced, 'code socket');
          assert.equal(
            (
              await client().request('/security/recover', {
                email: alice.email,
                password: 'wrong',
                code: codes[0],
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await client().request('/security/recover', {
                email: alice.email,
                password: password + '-new',
                code: 'wrong',
              })
            ).status,
            403,
          );
          const contenders = [client(), client()];
          const results = await Promise.all(
            contenders.map((b) =>
              b.request('/security/recover', {
                email: alice.email,
                password: password + '-new',
                code: codes[0],
              }),
            ),
          );
          assert.equal(results.filter((x) => x.status === 200).length, 1);
          recovery = contenders[results.findIndex((x) => x.status === 200)]!;
          await until(() => live.closed, 'code closes socket', 5000);
          const s = await ok(recovery.request('/security/status'));
          assert.equal(s.recovery, true);
          assert.equal(s.strong, false);
          const expiry = (
            await db.pool.query('SELECT expires_at FROM auth_sessions WHERE id=$1', [s.sessionId])
          ).rows[0].expires_at;
          assert(Math.abs(new Date(expiry).getTime() - Date.now() - 900000) < 10000);
          for (const base of [r.base, optional.base])
            assert.equal((await recovery.request(base + '/pages')).status, 403);
          const refused = peer(recovery, optional.workspace, optional.page, optional.generation);
          await until(() => refused.failed || refused.closed, 'limited socket denied');
          assert.equal(refused.provider.isSynced, false);
          assert.equal((await recovery.request('/security/recovery-codes', {})).status, 403);
          assert.equal((await recovery.request('/security/recovery-finish', {})).status, 403);
          assert.equal(
            (
              await recovery.request(
                r.base + '/security',
                { requireStrongAuth: false, graceDays: 0, expectedVersion: 1 },
                'PUT',
              )
            ).status,
            403,
          );
        },
      );
      await t.test(
        'replace lost passkey, finish regenerates codes, no content until separate UV proof; shared-computer flag preserved',
        async () => {
          const savedCookie = recovery.cookie();
          const factor = (
            await db.pool.query('SELECT id FROM auth_passkeys WHERE user_id=$1', [alice.id])
          ).rows[0].id;
          await ok(
            recovery.request('/security/recovery-remove-factor', { factor: 'passkey:' + factor }),
          );
          assert.equal((await recovery.request(r.base + '/pages')).status, 403);
          const replacement = testAuthenticator();
          await enroll(recovery, replacement);
          const anonymous = client();
          const anonymousOptions = await ok(
            anonymous.request('/passkey/generate-authenticate-options'),
          );
          assert.equal(
            (
              await anonymous.request('/passkey/verify-authentication', {
                response: replacement.authenticate(String(anonymousOptions.challenge)),
              })
            ).status,
            403,
          );
          const options = await ok(recovery.request('/passkey/generate-authenticate-options'));
          assert.equal(
            (
              await recovery.request('/passkey/verify-authentication', {
                response: replacement.authenticate(String(options.challenge)),
              })
            ).status,
            403,
          );
          const finished = await ok(recovery.request('/security/recovery-finish', {}));
          assert.equal((finished.recoveryCodes as string[]).length, 10);
          assert.equal((await client(savedCookie).request('/security/status')).status, 403);
          assert.equal((await recovery.request(r.base + '/pages')).status, 403);
          assert.equal(
            (
              await client().request('/security/recover', {
                email: alice.email,
                password: password + '-new',
                code: codes[1],
              })
            ).status,
            403,
          );
          await prove(recovery, replacement);
          await ok(recovery.request(r.base + '/pages'));
          assert.equal(
            (
              await db.pool.query(
                'SELECT shared_computer FROM session_security WHERE session_id=$1',
                [(await sid(recovery)).id],
              )
            ).rows[0].shared_computer,
            true,
          );
          assert.equal(
            (
              await db.pool.query(
                'SELECT recovery_required FROM account_security WHERE user_id=$1',
                [alice.id],
              )
            ).rows[0].recovery_required,
            false,
          );
          alice.browser = recovery;
          alice.key = replacement;
        },
      );
      const operator = {
        userId: alice.id,
        factor: 'all',
        reason: 'Test lost hardware',
        operator: 'test operator',
        apply: false,
        origin: config.APP_ORIGIN,
        secret: config.BETTER_AUTH_SECRET,
      };
      await t.test(
        'operator dry-run, exact confirmation and target checks; targeted reset preserves spare factor and closes socket',
        async () => {
          const spare = testAuthenticator();
          await enroll(alice.browser, spare);
          await prove(alice.browser, spare);
          const factor = (
            await db.pool.query('SELECT id FROM auth_passkeys WHERE user_id=$1 ORDER BY id', [
              alice.id,
            ])
          ).rows[0].id;
          const before = (await db.pool.query('SELECT count(*) FROM auth_security_events')).rows[0]
            .count;
          const cli = await promisify(execFile)(
            process.execPath,
            [
              'apps/worker/dist/reset-factor.mjs',
              '--user-id',
              alice.id,
              '--factor',
              'passkey:' + factor,
              '--reason',
              operator.reason,
              '--operator',
              operator.operator,
            ],
            { env: { ...process.env, DATABASE_URL: db.url }, windowsHide: true },
          );
          assert.equal(JSON.parse(cli.stdout).applied, false);
          assert.equal(
            (await db.pool.query('SELECT count(*) FROM auth_security_events')).rows[0].count,
            before,
          );
          for (const opts of [
            { ...operator, apply: true },
            { ...operator, userId: randomUUID() },
            { ...operator, factor: 'passkey:' + randomUUID() },
            { ...operator, reason: '' },
          ])
            await assert.rejects(operatorReset(connection.db, opts));
          const live = peer(alice.browser, r.workspace, r.page, r.generation);
          await until(() => live.provider.isSynced, 'operator socket');
          const applied = await promisify(execFile)(
            process.execPath,
            [
              'apps/worker/dist/reset-factor.mjs',
              '--user-id',
              alice.id,
              '--factor',
              'passkey:' + factor,
              '--reason',
              operator.reason,
              '--operator',
              operator.operator,
              '--apply',
              '--confirm',
              alice.id,
            ],
            { env: { ...process.env, DATABASE_URL: db.url }, windowsHide: true },
          );
          assert.equal(JSON.parse(applied.stdout).applied, true);
          assert(!applied.stdout.includes('#operator='));
          await until(() => live.closed, 'operator closes socket', 5000);
          assert.equal(
            (await db.pool.query('SELECT 1 FROM auth_passkeys WHERE user_id=$1', [alice.id]))
              .rowCount,
            1,
          );
          assert.equal(
            (await db.pool.query('SELECT 1 FROM auth_recovery_codes WHERE user_id=$1', [alice.id]))
              .rowCount,
            0,
          );
          const audit = (
            await db.pool.query(
              "SELECT operator,reason,target FROM auth_security_events WHERE user_id=$1 AND action='operator_factor_reset'",
              [alice.id],
            )
          ).rows[0];
          assert.deepEqual(audit, {
            operator: operator.operator,
            reason: operator.reason,
            target: 'passkey:' + factor,
          });
        },
      );
      await t.test(
        'operator full reset preserves policy; expired grant can be reissued but password alone cannot enroll or read',
        async () => {
          await operatorReset(connection.db, { ...operator, apply: true, confirm: alice.id });
          await drain();
          const first = mails
            .filter((m) => m.email === alice.email && m.text.includes('#operator='))
            .at(-1)!
            .text.match(/#operator=([^\s]+)/)![1]!;
          await db.pool.query(
            "UPDATE auth_operator_recovery SET expires_at=now()-interval '1 second' WHERE user_id=$1",
            [alice.id],
          );
          assert.equal(
            (
              await client().request('/security/operator-recover', {
                email: alice.email,
                password: password + '-new',
                code: first,
              })
            ).status,
            403,
          );
          const b = client();
          assert.equal(
            (
              await ok(
                b.request('/sign-in/email', { email: alice.email, password: password + '-new' }),
              )
            ).requiresStrongAuth,
            true,
          );
          assert.equal((await b.request(r.base + '/pages')).status, 403);
          assert.equal((await b.request('/passkey/generate-register-options')).status, 403);
          await operatorReset(connection.db, { ...operator, apply: true, confirm: alice.id });
          await drain();
          const grant = mails
            .filter((m) => m.email === alice.email && m.text.includes('#operator='))
            .at(-1)!
            .text.match(/#operator=([^\s]+)/)![1]!;
          assert.notEqual(grant, first);
          assert.equal(
            (
              await client().request('/security/operator-recover', {
                email: alice.email,
                password: 'wrong',
                code: grant,
              })
            ).status,
            403,
          );
          const pair = [client(), client()];
          const result = await Promise.all(
            pair.map((b) =>
              b.request('/security/operator-recover', {
                email: alice.email,
                password: password + '-new',
                code: grant,
              }),
            ),
          );
          assert.equal(result.filter((x) => x.status === 200).length, 1);
          const limited = pair[result.findIndex((x) => x.status === 200)]!;
          assert.equal((await ok(limited.request('/security/status'))).recovery, true);
          const session = (await sid(limited)).id;
          await db.pool.query(
            "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
            [session],
          );
          assert.equal((await limited.request('/security/status')).status, 403);
          assert.equal(
            (
              await db.pool.query(
                'SELECT require_strong_auth FROM workspace_policies WHERE workspace_id=$1',
                [r.workspace],
              )
            ).rows[0].require_strong_auth,
            true,
          );
        },
      );
      await t.test(
        'mail transport failure retries durably, then purges ciphertext; unknown requests do not send',
        async () => {
          await drain();
          await ok(client().request('/security/request-password-reset', { email: alice.email }));
          assert(await processAuthMail(connection.db, mailOptions));
          const reports: unknown[] = [];
          for (let n = 0; n < 6; n++) {
            assert(
              await processAuthMail(connection.db, {
                ...mailOptions,
                send: async () => {
                  throw new Error('SMTP unavailable');
                },
                report: (e) => reports.push(e),
              }),
            );
            await db.pool.query('UPDATE auth_mail_jobs SET available_at=now()');
          }
          assert.equal((await db.pool.query('SELECT 1 FROM auth_mail_jobs')).rowCount, 0);
          assert.equal(reports.length, 6);
        },
      );
      await t.test(
        'TOTP-only recovery, quarantined factor survives logout; explicit finish and fresh OTP required',
        async () => {
          const u = await user();
          const setup = await ok(u.browser.request('/two-factor/enable', { password }));
          const otp = testOtp(String(setup.totpURI));
          const challenge = await ok(u.browser.request('/security/challenge', {}));
          const enrolled = await ok(
            u.browser.request(
              '/two-factor/verify-totp',
              { code: await otp.hotp(Math.floor(Date.now() / 30000) - 1) },
              'POST',
              { 'x-memoria-challenge': String(challenge.id) },
            ),
          );
          const initialCodes = enrolled.recoveryCodes as string[];
          const b = client();
          await ok(
            b.request('/security/recover', { email: u.email, password, code: initialCodes[0] }),
          );
          await ok(b.request('/security/recovery-remove-factor', { factor: 'totp' }));
          const setup2 = await ok(b.request('/two-factor/enable', { password }));
          const otp2 = testOtp(String(setup2.totpURI));
          const c = await ok(b.request('/security/challenge', {}));
          await ok(
            b.request(
              '/two-factor/verify-totp',
              { code: await otp2.hotp(Math.floor(Date.now() / 30000) - 1) },
              'POST',
              { 'x-memoria-challenge': String(c.id) },
            ),
          );
          const s = (await sid(b)).id;
          await db.pool.query(
            "UPDATE auth_sessions SET expires_at=now()+interval '7 days' WHERE id=$1",
            [s],
          );
          assert(
            new Date(
              (await db.pool.query('SELECT expires_at FROM auth_sessions WHERE id=$1', [s])).rows[0]
                .expires_at,
            ).getTime() <
              Date.now() + 901000,
          );
          await ok(b.request('/sign-out', {}));
          await ok(b.request('/sign-in/email', { email: u.email, password }));
          const c2 = await ok(b.request('/security/challenge', {}));
          assert.equal(
            (
              await b.request('/two-factor/verify-totp', { code: await otp2.totp() }, 'POST', {
                'x-memoria-challenge': String(c2.id),
              })
            ).status,
            403,
          );
          await ok(
            b.request('/security/recover', { email: u.email, password, code: initialCodes[1] }),
          );
          await ok(b.request('/security/recovery-remove-factor', { factor: 'totp' }));
          const setup3 = await ok(b.request('/two-factor/enable', { password }));
          const otp3 = testOtp(String(setup3.totpURI));
          const c3 = await ok(b.request('/security/challenge', {}));
          await ok(
            b.request(
              '/two-factor/verify-totp',
              { code: await otp3.hotp(Math.floor(Date.now() / 30000) - 1) },
              'POST',
              { 'x-memoria-challenge': String(c3.id) },
            ),
          );
          const completed = await ok(b.request('/security/recovery-finish', {}));
          assert.equal((completed.recoveryCodes as string[]).length, 10);
          assert.equal((await b.request('/api/internal/workspaces')).status, 403);
          const c4 = await ok(b.request('/security/challenge', {}));
          await ok(
            b.request('/two-factor/verify-totp', { code: await otp3.totp() }, 'POST', {
              'x-memoria-challenge': String(c4.id),
            }),
          );
          await ok(b.request('/api/internal/workspaces'));
        },
      );
      await t.test(
        'recovery mutation rollback and CSRF; operator rollback leaves factor and sessions untouched',
        async () => {
          const u = await user();
          const set = (await enroll(u.browser, u.key)).recoveryCodes as string[];
          await prove(u.browser, u.key);
          for (const Origin of ['', 'https://attacker.invalid'])
            assert.equal(
              (
                await client().request(
                  '/security/recover',
                  { email: u.email, password, code: set[0] },
                  'POST',
                  { Origin },
                )
              ).status,
              403,
            );
          const session = (await sid(u.browser)).id;
          await db.pool.query(
            "CREATE FUNCTION fail_recovery_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action IN ('recovery_code_consumed','operator_factor_reset') THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_recovery BEFORE INSERT ON auth_security_events FOR EACH ROW EXECUTE FUNCTION fail_recovery_audit()",
          );
          try {
            assert.equal(
              (
                await client().request('/security/recover', {
                  email: u.email,
                  password,
                  code: set[0],
                })
              ).status,
              500,
            );
            await assert.rejects(
              operatorReset(connection.db, {
                ...operator,
                userId: u.id,
                apply: true,
                confirm: u.id,
              }),
            );
          } finally {
            await db.pool.query(
              'DROP TRIGGER fail_recovery ON auth_security_events; DROP FUNCTION fail_recovery_audit()',
            );
          }
          assert.equal((await sid(u.browser)).id, session);
          assert.equal((await ok(u.browser.request('/security/status'))).strong, true);
          await ok(
            client().request('/security/recover', { email: u.email, password, code: set[0] }),
          );
        },
      );
      await t.test(
        'password reset during recovery revokes its limited session without reopening password-only access',
        async () => {
          const u = await user(),
            initial = (await enroll(u.browser, u.key)).recoveryCodes as string[];
          const b = client();
          await ok(b.request('/security/recover', { email: u.email, password, code: initial[0] }));
          await ok(b.request('/security/recovery-remove-factor', { factor: 'all' }));
          const prior = (await sid(b)).id,
            grant = await resetToken(u.email);
          await ok(
            client().request('/reset-password', {
              token: grant,
              newPassword: password + '-changed',
            }),
          );
          assert.equal(
            (await db.pool.query('SELECT 1 FROM auth_sessions WHERE id=$1', [prior])).rowCount,
            0,
          );
          const pending = client();
          assert.equal(
            (
              await ok(
                pending.request('/sign-in/email', {
                  email: u.email,
                  password: password + '-changed',
                }),
              )
            ).requiresStrongAuth,
            true,
          );
          assert.equal((await pending.request('/api/internal/workspaces')).status, 403);
          assert.equal((await pending.request('/passkey/generate-register-options')).status, 403);
          await ok(
            pending.request('/security/recover', {
              email: u.email,
              password: password + '-changed',
              code: initial[1],
            }),
          );
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
