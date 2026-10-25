import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth, readAssurance } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { resolveAccess } from '../../collab/src/service/access.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { testOtp } from '../../../packages/auth/src/testing/otp.ts';

await test(
  '4a: real Nest, Better Auth, PostgreSQL and cryptographic factors',
  { timeout: 180000 },
  async (t) => {
    process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
    const database = await testDatabase();
    const original = process.env.DATABASE_URL;
    process.env.DATABASE_URL = database.url;
    const config = readConfig();
    const connection = createDatabase(database.url);
    const app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    app.set('trust proxy', 'loopback');
    const password = 'fixture-only-strong-auth-4a';
    const auth = createAuth(connection.db, {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      sendVerificationEmail: async () => {},
    });
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      let ip = 1;
      function client() {
        const jar = new Map<string, string>();
        return {
          jar,
          async request(path: string, body?: unknown, extra: Record<string, string> = {}) {
            const response = await fetch(
              `${origin}${path.startsWith('/api/') ? path : `/api/auth${path}`}`,
              {
                method: body === undefined ? 'GET' : 'POST',
                headers: {
                  'Content-Type': 'application/json',
                  Origin: config.APP_ORIGIN,
                  'x-forwarded-for': `2001:db8:${(ip++).toString(16)}::1`,
                  Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; '),
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
            const data = (await response.json()) as Record<string, unknown>;
            return { status: response.status, data };
          },
        };
      }
      async function user() {
        const email = `${randomUUID()}@example.test`;
        const created = await auth.api.signUpEmail({
          body: { email, name: 'Factor test', password },
        });
        await database.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [
          created.user.id,
        ]);
        const browser = client();
        const signed = await browser.request('/sign-in/email', { email, password });
        assert.equal(signed.status, 200, JSON.stringify(signed.data));
        return { email, id: created.user.id, browser };
      }
      async function sessionId(browser: ReturnType<typeof client>) {
        const result = await browser.request('/get-session');
        return (result.data?.session as { id: string } | undefined)?.id;
      }
      const alice = await user(),
        bob = await user();
      let otp: ReturnType<typeof testOtp>;
      const key = testAuthenticator();
      await t.test(
        'the first factor requires a password confirmed in the last five minutes',
        async () => {
          const id = (await sessionId(alice.browser))!;
          await database.pool.query(
            "UPDATE session_security SET password_verified_at=now()-interval '301 seconds' WHERE session_id=$1",
            [id],
          );
          assert.equal(
            (await alice.browser.request('/two-factor/enable', { password })).status,
            403,
          );
          assert.equal(
            (await alice.browser.request('/passkey/generate-register-options')).status,
            403,
          );
          assert.equal((await alice.browser.request('/verify-password', { password })).status, 200);
        },
      );
      await t.test(
        'TOTP enrollment returns common codes without promoting the session; content and SQL collaboration deny the challenge',
        async () => {
          const enabled = await alice.browser.request('/two-factor/enable', { password });
          assert.equal(enabled.status, 200, JSON.stringify(enabled.data));
          assert.equal(enabled.data.backupCodes, undefined);
          otp = testOtp(String(enabled.data.totpURI));
          const challenge = await alice.browser.request('/security/challenge', {});
          assert.equal(challenge.status, 200, JSON.stringify(challenge.data));
          const verified = await alice.browser.request(
            '/two-factor/verify-totp',
            { code: await otp.hotp(Math.floor(Date.now() / 30000) - 1) },
            { 'x-memoria-challenge': String(challenge.data.id) },
          );
          assert.equal(verified.status, 200, JSON.stringify(verified.data));
          assert.equal((verified.data.recoveryCodes as string[]).length, 10);
          assert.equal(new Set(verified.data.recoveryCodes as string[]).size, 10);
          assert.equal(
            (await readAssurance(connection.db, (await sessionId(alice.browser))!)).strong,
            false,
          );
          assert.equal((await alice.browser.request('/api/internal/workspaces')).status, 403);
          await database.pool.query(
            "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
            [database.workspace, alice.id],
          );
          await database.pool.query(
            "INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')",
            [database.workspace, alice.id],
          );
          const access = await resolveAccess(database.pool, [
            {
              key: 'test',
              user: alice.id,
              session: (await sessionId(alice.browser))!,
              workspace: database.workspace,
              page: database.page,
            },
          ]);
          assert.equal(access.size, 0);
          const stored = await database.pool.query(
            'SELECT hash FROM auth_recovery_codes WHERE user_id=$1',
            [alice.id],
          );
          assert.equal(stored.rowCount, 10);
          for (const code of verified.data.recoveryCodes as string[])
            assert.ok(!JSON.stringify(stored.rows).includes(code));
        },
      );
      await t.test(
        'TOTP explicit authentication rotates the session and concurrent replay succeeds once',
        async () => {
          const previous = (await sessionId(alice.browser))!;
          const second = client();
          for (const [k, v] of alice.browser.jar) second.jar.set(k, v);
          const challenge = await alice.browser.request('/security/challenge', {});
          const code = await otp.hotp(Math.floor(Date.now() / 30000));
          const results = await Promise.all(
            [alice.browser, second].map((b) =>
              b.request(
                '/two-factor/verify-totp',
                { code },
                { 'x-memoria-challenge': String(challenge.data.id) },
              ),
            ),
          );
          assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
          if (results[1]!.status === 200) {
            alice.browser.jar.clear();
            for (const [k, v] of second.jar) alice.browser.jar.set(k, v);
          }
          const current = (await sessionId(alice.browser))!;
          assert.notEqual(current, previous);
          assert.equal((await readAssurance(connection.db, current)).strong, true);
          assert.equal((await alice.browser.request('/api/internal/workspaces')).status, 200);
          assert.equal(
            (await database.pool.query('SELECT 1 FROM auth_sessions WHERE id=$1', [previous]))
              .rowCount,
            0,
          );
        },
      );
      await t.test(
        'five failed attempts persist, re-request does not reset them, expired and trusted-device requests fail',
        async () => {
          const pending = client();
          assert.equal(
            (await pending.request('/sign-in/email', { email: alice.email, password })).data
              .requiresStrongAuth,
            true,
          );
          const challenge = await pending.request('/security/challenge', {}),
            id = String(challenge.data.id);
          const headers = { 'x-memoria-challenge': id };
          assert.equal(
            (
              await pending.request(
                '/two-factor/verify-totp',
                { code: '000000', trustDevice: true },
                headers,
              )
            ).status,
            403,
          );
          const validCodes = await Promise.all(
            [-1, 0, 1].map((offset) => otp.hotp(Math.floor(Date.now() / 30000) + offset)),
          );
          const badCode = ['000000', '111111', '222222', '333333'].find(
            (code) => !validCodes.includes(code),
          )!;
          for (let i = 0; i < 5; i++)
            assert.notEqual(
              (
                await pending.request(
                  '/two-factor/verify-totp',
                  { code: i === 0 ? badCode : 'invalid' },
                  headers,
                )
              ).status,
              200,
            );
          const again = await pending.request('/security/challenge', {});
          assert.equal(again.data.id, id);
          assert.equal(again.data.attemptsRemaining, 0);
          assert.equal(
            (await pending.request('/two-factor/verify-totp', { code: await otp.totp() }, headers))
              .status,
            403,
          );
          await database.pool.query(
            "UPDATE auth_factor_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
            [id],
          );
          assert.equal(
            (await pending.request('/two-factor/verify-totp', { code: await otp.totp() }, headers))
              .status,
            403,
          );
          for (const path of [
            '/two-factor/verify-backup-code',
            '/two-factor/get-totp-uri',
            '/two-factor/send-otp',
          ])
            assert.equal((await pending.request(path, {})).status, 404);
        },
      );
      await t.test(
        'passkey registration rejects signed UV=false and accepts UV=true without creating assurance',
        async () => {
          let options = await alice.browser.request('/passkey/generate-register-options');
          assert.equal(options.status, 200, JSON.stringify(options.data));
          assert.equal(
            (options.data.authenticatorSelection as { userVerification: string }).userVerification,
            'required',
          );
          const rejected = await alice.browser.request('/passkey/verify-registration', {
            response: key.register(String(options.data.challenge), false),
            name: 'Test key',
          });
          assert.equal(rejected.status, 403, JSON.stringify(rejected.data));
          assert.equal(
            (await database.pool.query('SELECT 1 FROM auth_passkeys WHERE user_id=$1', [alice.id]))
              .rowCount,
            0,
          );
          options = await alice.browser.request('/passkey/generate-register-options');
          const accepted = await alice.browser.request('/passkey/verify-registration', {
            response: key.register(String(options.data.challenge)),
            name: 'Test key',
          });
          assert.equal(accepted.status, 200, JSON.stringify(accepted.data));
          assert.equal(
            (await readAssurance(connection.db, (await sessionId(alice.browser))!)).strong,
            false,
          );
        },
      );
      await t.test(
        'passkey authentication enforces UV, origin, RP ID, challenge and binds identity',
        async () => {
          for (const [uv, origin, rp] of [
            [false, 'https://localhost', 'localhost'],
            [true, 'https://attacker.invalid', 'localhost'],
            [true, 'https://localhost', 'attacker.invalid'],
          ] as const) {
            const options = await alice.browser.request('/passkey/generate-authenticate-options');
            assert.equal(options.data.userVerification, 'required');
            const attempt = await alice.browser.request('/passkey/verify-authentication', {
              response: key.authenticate(String(options.data.challenge), uv, origin, rp),
            });
            assert.notEqual(attempt.status, 200, JSON.stringify(attempt.data));
          }
          const swap = await bob.browser.request('/passkey/generate-authenticate-options');
          assert.equal(
            (
              await bob.browser.request('/passkey/verify-authentication', {
                response: key.authenticate(String(swap.data.challenge)),
              })
            ).status,
            403,
          );
          const opts = await alice.browser.request('/passkey/generate-authenticate-options');
          const assertion = key.authenticate(String(opts.data.challenge));
          const verified = await alice.browser.request('/passkey/verify-authentication', {
            response: assertion,
          });
          assert.equal(verified.status, 200, JSON.stringify(verified.data));
          assert.equal(
            (await readAssurance(connection.db, (await sessionId(alice.browser))!)).method,
            'passkey',
          );
          assert.notEqual(
            (await alice.browser.request('/passkey/verify-authentication', { response: assertion }))
              .status,
            200,
          );
        },
      );
      await t.test(
        'passkey challenges reject wrong values, expiration and concurrent replay',
        async () => {
          await alice.browser.request('/passkey/generate-authenticate-options');
          assert.notEqual(
            (
              await alice.browser.request('/passkey/verify-authentication', {
                response: key.authenticate('wrong-challenge'),
              })
            ).status,
            200,
          );
          const expiring = await alice.browser.request('/passkey/generate-authenticate-options');
          await database.pool.query(
            "UPDATE auth_verifications SET expires_at=now()-interval '1 second' WHERE value LIKE '%authentication%'",
          );
          assert.equal(
            (
              await alice.browser.request('/passkey/verify-authentication', {
                response: key.authenticate(String(expiring.data.challenge)),
              })
            ).status,
            403,
          );
          const options = await alice.browser.request('/passkey/generate-authenticate-options');
          const second = client();
          for (const [k, v] of alice.browser.jar) second.jar.set(k, v);
          const response = key.authenticate(String(options.data.challenge));
          const results = await Promise.all(
            [alice.browser, second].map((b) =>
              b.request('/passkey/verify-authentication', { response }),
            ),
          );
          assert.equal(results.filter((r) => r.status === 200).length, 1, JSON.stringify(results));
          if (results[1]!.status === 200) {
            alice.browser.jar.clear();
            for (const [k, v] of second.jar) alice.browser.jar.set(k, v);
          }
          assert.equal(
            (await readAssurance(connection.db, (await sessionId(alice.browser))!)).strong,
            true,
          );
        },
      );
      await t.test(
        'expired assurance cannot manage factors or regenerate common codes',
        async () => {
          const id = (await sessionId(alice.browser))!;
          await database.pool.query(
            "UPDATE session_assurance SET verified_at=now()-interval '601 seconds' WHERE session_id=$1",
            [id],
          );
          assert.equal((await alice.browser.request('/security/recovery-codes', {})).status, 403);
          assert.equal(
            (await alice.browser.request('/two-factor/disable', { password })).status,
            403,
          );
          assert.equal((await alice.browser.request('/api/internal/workspaces')).status, 200);
        },
      );
      await t.test(
        'failed assurance INSERT rolls back the new session, no success cookie escapes',
        async () => {
          const before = (
            await database.pool.query('SELECT id FROM auth_sessions WHERE user_id=$1 ORDER BY id', [
              alice.id,
            ])
          ).rows;
          await database.pool.query(
            "CREATE FUNCTION fail_assurance_test() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'test failure'; END $$; CREATE TRIGGER fail_assurance_test BEFORE INSERT ON session_assurance FOR EACH ROW EXECUTE FUNCTION fail_assurance_test()",
          );
          try {
            const options = await alice.browser.request('/passkey/generate-authenticate-options');
            const cookiesBefore = [...alice.browser.jar];
            const result = await alice.browser.request('/passkey/verify-authentication', {
              response: key.authenticate(String(options.data.challenge)),
            });
            assert.equal(result.status, 500);
            assert.deepEqual([...alice.browser.jar], cookiesBefore);
            assert.deepEqual(
              (
                await database.pool.query(
                  'SELECT id FROM auth_sessions WHERE user_id=$1 ORDER BY id',
                  [alice.id],
                )
              ).rows,
              before,
            );
          } finally {
            await database.pool.query(
              'DROP TRIGGER fail_assurance_test ON session_assurance; DROP FUNCTION fail_assurance_test()',
            );
          }
        },
      );
      await t.test(
        'a passkey-only account has common codes, password alone is restricted and anonymous UV sign-in works',
        async () => {
          const onlyKey = testAuthenticator();
          const options = await bob.browser.request('/passkey/generate-register-options');
          const added = await bob.browser.request('/passkey/verify-registration', {
            response: onlyKey.register(String(options.data.challenge)),
            name: 'Passkey only',
          });
          assert.equal(added.status, 200, JSON.stringify(added.data));
          assert.equal((added.data.recoveryCodes as string[]).length, 10);
          const pending = client();
          const login = await pending.request('/sign-in/email', { email: bob.email, password });
          assert.equal(login.data.requiresStrongAuth, true);
          assert.equal((await pending.request('/api/internal/workspaces')).status, 403);
          const anonymous = client();
          const challenge = await anonymous.request('/passkey/generate-authenticate-options');
          const signed = await anonymous.request('/passkey/verify-authentication', {
            response: onlyKey.authenticate(String(challenge.data.challenge)),
          });
          assert.equal(signed.status, 200, JSON.stringify(signed.data));
          assert.equal(
            (await readAssurance(connection.db, (await sessionId(anonymous))!)).strong,
            true,
          );
          assert.equal((await anonymous.request('/api/internal/workspaces')).status, 200);
        },
      );
      await t.test(
        'reauthentication preserves server session settings and account generation invalidates an old proof',
        async () => {
          const before = (await sessionId(alice.browser))!;
          await database.pool.query(
            'INSERT INTO session_security(session_id,shared_computer) VALUES($1,true) ON CONFLICT(session_id) DO UPDATE SET shared_computer=true',
            [before],
          );
          const options = await alice.browser.request('/passkey/generate-authenticate-options');
          assert.equal(
            (
              await alice.browser.request('/passkey/verify-authentication', {
                response: key.authenticate(String(options.data.challenge)),
              })
            ).status,
            200,
          );
          const current = (await sessionId(alice.browser))!;
          assert.equal(
            (
              await database.pool.query(
                'SELECT shared_computer FROM session_security WHERE session_id=$1',
                [current],
              )
            ).rows[0].shared_computer,
            true,
          );
          await database.pool.query(
            'UPDATE account_security SET version=version+1 WHERE user_id=$1',
            [alice.id],
          );
          assert.equal((await readAssurance(connection.db, current)).strong, false);
          assert.equal((await alice.browser.request('/api/internal/workspaces')).status, 403);
        },
      );
      await t.test(
        'password confirmation cannot promote or replace a factor, and cross-origin mutations fail',
        async () => {
          assert.equal((await alice.browser.request('/verify-password', { password })).status, 200);
          assert.equal(
            (await alice.browser.request('/passkey/generate-register-options')).status,
            403,
          );
          const otherOrigin = await alice.browser.request(
            '/security/challenge',
            {},
            { Origin: 'https://attacker.invalid' },
          );
          assert.equal(otherOrigin.status, 403);
          const noOrigin = await alice.browser.request('/security/challenge', {}, { Origin: '' });
          assert.equal(noOrigin.status, 403);
        },
      );
      await t.test(
        'regeneration invalidates the old common set and removing a factor revokes every session and assurance',
        async () => {
          const options = await alice.browser.request('/passkey/generate-authenticate-options');
          assert.equal(
            (
              await alice.browser.request('/passkey/verify-authentication', {
                response: key.authenticate(String(options.data.challenge)),
              })
            ).status,
            200,
          );
          const old = (
            await database.pool.query('SELECT hash FROM auth_recovery_codes WHERE user_id=$1', [
              alice.id,
            ])
          ).rows.map((r) => r.hash);
          const replacement = await alice.browser.request('/security/recovery-codes', {});
          assert.equal(replacement.status, 200);
          assert.equal((replacement.data.recoveryCodes as string[]).length, 10);
          assert.ok(
            (
              await database.pool.query('SELECT hash FROM auth_recovery_codes WHERE user_id=$1', [
                alice.id,
              ])
            ).rows.every((r) => !old.includes(r.hash)),
          );
          const disabled = await alice.browser.request('/two-factor/disable', { password });
          assert.equal(disabled.status, 200, JSON.stringify(disabled.data));
          assert.equal(
            (await database.pool.query('SELECT 1 FROM auth_sessions WHERE user_id=$1', [alice.id]))
              .rowCount,
            0,
          );
          assert.equal(
            (
              await database.pool.query(
                'SELECT 1 FROM session_assurance a JOIN auth_passkeys p ON p.id=a.factor_id WHERE p.user_id=$1',
                [alice.id],
              )
            ).rowCount,
            0,
          );
        },
      );
    } finally {
      await app.close();
      await connection.pool.end();
      await database.close();
      if (original === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = original;
    }
  },
);
