import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import {
  accountKey,
  delaySeconds,
  emailBudget,
  purgeAuthCounters,
  ipKey,
  admitAttempt,
  finishAttempt,
  waitAttempt,
} from '../../../packages/auth/src/throttle.ts';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { testAuthenticator } from './testing/webauthn.ts';

await test(
  '4d: real Nest/Better Auth/PostgreSQL admission on two API nodes',
  { timeout: 240000 },
  async (t) => {
    process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
    const fixture = await testDatabase();
    process.env.DATABASE_URL = fixture.url;
    const db = createDatabase(fixture.url),
      config = readConfig();
    const apps: NestExpressApplication[] = [],
      origins: string[] = [];
    for (let i = 0; i < 2; i++) {
      const app = await NestFactory.create<NestExpressApplication>(AppModule, {
        bodyParser: false,
        logger: false,
      });
      configureApplication(app);
      app.set('trust proxy', 'loopback');
      await app.listen(0, '127.0.0.1');
      apps.push(app);
      origins.push(await app.getUrl());
    }
    const auth = createAuth(db.db, {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      sendVerificationEmail: async () => {},
    });
    const password = 'fixture-only-long-password-4d';
    const request = async (
      path: string,
      body: unknown,
      ip = '192.0.2.50',
      node = 0,
      signal?: AbortSignal,
      headers: Record<string, string> = {},
    ) => {
      const response = await fetch(origins[node] + '/api/auth' + path, {
        method: body === undefined ? 'GET' : 'POST',
        headers: {
          Origin: config.APP_ORIGIN,
          'Content-Type': 'application/json',
          'x-forwarded-for': ip,
          'x-memoria-client-ip': randomUUID(),
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        ...(signal ? { signal } : {}),
      });
      return {
        status: response.status,
        data: (await response.json()) as Record<string, unknown>,
        headers: response.headers,
      };
    };
    async function user() {
      const email = `${randomUUID()}@example.test`;
      const created = await auth.api.signUpEmail({
        body: { name: 'Quota fixture', email, password },
      });
      await fixture.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [
        created.user.id,
      ]);
      return { email, id: created.user.id };
    }
    const login = (
      email: string,
      pass = password,
      ip = '192.0.2.50',
      node = 0,
      signal?: AbortSignal,
    ) => request('/sign-in/email', { email, password: pass }, ip, node, signal);
    const state = async (email: string) =>
      (
        await fixture.pool.query('SELECT * FROM auth_attempt_accounts WHERE key=$1', [
          accountKey(config.BETTER_AUTH_SECRET, email),
        ])
      ).rows[0];
    const waitLeases = async (email: string, n: number) => {
      for (let i = 0; i < 100; i++) {
        const rows = (
          await fixture.pool.query(
            'SELECT * FROM auth_attempt_leases WHERE account_key=$1 ORDER BY sequence',
            [accountKey(config.BETTER_AUTH_SECRET, email)],
          )
        ).rows;
        if (rows.length === n) return rows;
        await delay(20);
      }
      throw new Error('Admission did not reach expected lease count');
    };
    try {
      await t.test(
        '50 distinct accounts can each sign in behind one office NAT, across two nodes',
        async () => {
          const people = [];
          for (let i = 0; i < 50; i++) people.push(await user());
          let sampling = true,
            maxActive = 0,
            maxQueued = 0;
          const samples = (async () => {
            while (sampling) {
              const row = (
                await fixture.pool.query(
                  'SELECT count(*) AS total, count(*) FILTER(WHERE started_at IS NOT NULL) AS active FROM auth_attempt_leases',
                )
              ).rows[0];
              maxActive = Math.max(maxActive, Number(row.active));
              maxQueued = Math.max(maxQueued, Number(row.total));
              await delay(5);
            }
          })();
          const results = await Promise.all(
            people.map((p, i) => login(p.email, password, '192.0.2.50', i % 2)),
          ).finally(async () => {
            sampling = false;
            await samples;
          });
          assert.ok(maxActive > 0 && maxActive <= 8, `active ${maxActive}`);
          assert.ok(maxQueued <= 128 && maxQueued > 8, `queued ${maxQueued}`);
          console.info(
            `Observed admission: max active ${maxActive}/8; max leases ${maxQueued}/128 for 50 concurrent logins.`,
          );
          assert.equal(
            results.filter((r) => r.status === 200).length,
            50,
            JSON.stringify(results.filter((r) => r.status !== 200)),
          );
          assert.equal(
            Number(
              (await fixture.pool.query('SELECT count(*) n FROM auth_attempt_leases')).rows[0].n,
            ),
            0,
          );
        },
      );
      await t.test(
        'multi-IP failures share progressive delays; another account and unknown addresses behave correctly',
        async () => {
          const victim = await user(),
            other = await user();
          for (let i = 0; i < 5; i++)
            assert.equal(
              (await login(victim.email, 'incorrect-password', `198.51.100.${i + 1}`, i % 2))
                .status,
              401,
            );
          assert.equal((await state(victim.email)).failures, 5);
          const start = Date.now();
          const pending = login(
            victim.email.toUpperCase(),
            'incorrect-password',
            '198.51.100.30',
            1,
          );
          const rows = await waitLeases(victim.email, 1);
          assert.ok(new Date(rows[0].ready_at).getTime() - start >= 900);
          assert.equal((await login(other.email)).status, 200);
          assert.equal((await pending).status, 401);
          assert.ok(Date.now() - start >= 950);
          assert.equal((await state(victim.email)).failures, 6);
          const absent = `${randomUUID()}@example.test`;
          for (let i = 0; i < 5; i++)
            assert.equal(
              (await login(absent, 'incorrect-password', `203.0.113.${i + 1}`, i % 2)).status,
              401,
            );
          const unknownStart = Date.now();
          assert.equal((await login(absent, 'incorrect-password')).status, 401);
          assert.ok(Date.now() - unknownStart >= 950);
          assert.deepEqual(
            Array.from({ length: 12 }, (_, i) => delaySeconds(i)),
            [0, 0, 0, 0, 0, 1, 2, 4, 8, 16, 30, 30],
          );
        },
      );
      await t.test(
        'victim admitted at 30 seconds keeps its deadline during a parallel attack; cancellation releases SQL leases',
        async () => {
          const victim = await user();
          // Seed the already-tested failure counter at its plateau; the 30-second wait itself is real.
          const key = accountKey(config.BETTER_AUTH_SECRET, victim.email);
          await fixture.pool.query(
            'INSERT INTO auth_attempt_accounts(key,failures) VALUES($1,10)',
            [key],
          );
          const controllers = Array.from({ length: 7 }, () => new AbortController());
          const attack = (c: AbortController, i: number) =>
            login(victim.email, 'incorrect-password', `203.0.113.${i + 20}`, i % 2, c.signal).catch(
              () => null,
            );
          const attacks = controllers.slice(0, 2).map(attack);
          await waitLeases(victim.email, 2);
          const begin = Date.now(),
            good = login(victim.email);
          const admitted = (await waitLeases(victim.email, 3))[2];
          attacks.push(...controllers.slice(2).map((c, i) => attack(c, i + 2)));
          await waitLeases(victim.email, 8);
          for (let i = 0; i < 15; i++)
            assert.equal(
              (await login(victim.email, 'incorrect-password', `198.51.100.${i + 70}`, i % 2))
                .status,
              429,
            );
          const unchanged = (
            await fixture.pool.query('SELECT ready_at FROM auth_attempt_leases WHERE id=$1', [
              admitted.id,
            ])
          ).rows[0];
          assert.equal(
            new Date(unchanged.ready_at).getTime(),
            new Date(admitted.ready_at).getTime(),
          );
          // Abort one queued HTTP request and prove removal while the victim still waits.
          controllers[6]!.abort();
          await waitLeases(victim.email, 7);
          const result = await good;
          assert.equal(result.status, 200, JSON.stringify(result.data));
          const elapsed = Date.now() - begin;
          assert.ok(elapsed >= 29900 && elapsed < 35000, `victim wait ${elapsed}ms`);
          await Promise.all(attacks);
          assert.equal(
            (await state(victim.email)).failures,
            0,
            'older failures cannot undo complete authentication',
          );
          console.info(
            `Real admitted victim wait: ${elapsed} ms; fixed delay 30000 ms; victim arrives after two attackers; six failed passwords, one cancelled request, 15 rejected arrivals.`,
          );
        },
      );
      await t.test(
        'IP quotas are fixed, shared across nodes, immune to forged internal headers and IPv6 host changes',
        async () => {
          const ip = '2001:db8:8000:1234::1';
          for (let i = 0; i < 150; i++)
            assert.equal(
              (
                await request(
                  '/sign-in/email',
                  { email: 'invalid' },
                  i % 2 ? ip : '2001:db8:8000:1234::abcd',
                  i % 2,
                )
              ).status,
              400,
            );
          const denied = await request('/sign-in/email', { email: 'invalid' }, ip);
          assert.equal(denied.status, 429);
          assert.ok(Number(denied.headers.get('retry-after')) > 0);
          const key = ipKey(config.BETTER_AUTH_SECRET, '/sign-in/email', ip);
          const before = (
            await fixture.pool.query('SELECT started_at FROM auth_buckets WHERE key=$1', [key])
          ).rows[0];
          assert.ok(before);
          await request('/sign-in/email', { email: 'invalid' }, ip, 1);
          assert.equal(
            String(
              (await fixture.pool.query('SELECT started_at FROM auth_buckets WHERE key=$1', [key]))
                .rows[0].started_at,
            ),
            String(before.started_at),
          );
          await fixture.pool.query(
            "UPDATE auth_buckets SET started_at=now()-interval '61 seconds' WHERE key=$1",
            [key],
          );
          assert.equal((await request('/sign-in/email', { email: 'invalid' }, ip, 1)).status, 400);
        },
      );
      await t.test(
        'email budgets suppress delivery generically; windows, per-type separation and 24h purge are real SQL',
        async () => {
          const email = `${randomUUID()}@example.test`;
          for (let i = 0; i < 5; i++)
            assert.equal(
              (await request('/security/request-password-reset', { email }, `192.0.2.${i + 100}`))
                .status,
              200,
            );
          assert.equal(
            Number(
              (
                await fixture.pool.query(
                  "SELECT count(*) n FROM auth_mail_jobs WHERE kind='password-request'",
                )
              ).rows[0].n,
            ),
            3,
          );
          assert.equal(
            await emailBudget(db.db, config.BETTER_AUTH_SECRET, 'verification', email),
            true,
          );
          for (let i = 3; i < 10; i++) {
            await fixture.pool.query(
              "UPDATE auth_buckets SET started_at=now()-interval '16 minutes' WHERE key LIKE '%:15m'",
            );
            assert.equal(
              await emailBudget(db.db, config.BETTER_AUTH_SECRET, 'password', email),
              true,
            );
          }
          await fixture.pool.query(
            "UPDATE auth_buckets SET started_at=now()-interval '16 minutes' WHERE key LIKE '%:15m'",
          );
          assert.equal(
            await emailBudget(db.db, config.BETTER_AUTH_SECRET, 'password', email),
            false,
          );
          await fixture.pool.query("UPDATE auth_buckets SET touched_at=now()-interval '25 hours'");
          await purgeAuthCounters(db.db);
          assert.equal(
            Number((await fixture.pool.query('SELECT count(*) n FROM auth_buckets')).rows[0].n),
            0,
          );
        },
      );
      await t.test(
        'password-only pending MFA never resets failures; a verified UV passkey does',
        async () => {
          const person = await user(),
            key = testAuthenticator();
          const jar = new Map<string, string>();
          async function call(path: string, body?: unknown) {
            const r = await fetch(origins[0] + '/api/auth' + path, {
              method: body === undefined ? 'GET' : 'POST',
              headers: {
                Origin: config.APP_ORIGIN,
                'Content-Type': 'application/json',
                'x-forwarded-for': '192.0.2.180',
                Cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            for (const cookie of r.headers.getSetCookie()) {
              const pair = cookie.split(';')[0]!,
                i = pair.indexOf('=');
              jar.set(pair.slice(0, i), pair.slice(i + 1));
            }
            const result = (await r.json()) as Record<string, unknown>;
            assert.equal(r.status, 200, JSON.stringify(result));
            return result;
          }
          await call('/sign-in/email', { email: person.email, password });
          const options = await call('/passkey/generate-register-options');
          await call('/passkey/verify-registration', {
            response: key.register(String(options.challenge)),
            name: 'Quota UV key',
          });
          await fixture.pool.query('UPDATE auth_attempt_accounts SET failures=5 WHERE key=$1', [
            accountKey(config.BETTER_AUTH_SECRET, person.email),
          ]);
          jar.clear();
          assert.equal(
            (await call('/sign-in/email', { email: person.email, password })).requiresStrongAuth,
            true,
          );
          assert.equal((await state(person.email)).failures, 5);
          const proof = await call('/passkey/generate-authenticate-options');
          await call('/passkey/verify-authentication', {
            response: key.authenticate(String(proof.challenge)),
          });
          assert.equal((await state(person.email)).failures, 0);
        },
      );
      await t.test(
        'recovery challenges bind account/purpose, allow five guesses, expire, and renewal observes account delays',
        async () => {
          const email = `${randomUUID()}@example.test`,
            body = { email, password, code: 'incorrect-code' };
          assert.equal((await request('/security/recover', body)).data.code, 'CHALLENGE_REQUIRED');
          const challenge = await request('/security/recovery-challenge', {
            email,
            purpose: 'code',
          });
          const header = { 'x-memoria-recovery-challenge': String(challenge.data.id) };
          assert.equal(
            (await request('/security/operator-recover', body, '192.0.2.220', 0, undefined, header))
              .data.code,
            'CHALLENGE_EXHAUSTED_OR_EXPIRED',
          );
          assert.equal(
            (
              await request(
                '/security/recover',
                { ...body, email: 'other@example.test' },
                '192.0.2.220',
                1,
                undefined,
                header,
              )
            ).data.code,
            'CHALLENGE_EXHAUSTED_OR_EXPIRED',
          );
          for (let i = 0; i < 5; i++)
            assert.equal(
              (
                await request(
                  '/security/recover',
                  body,
                  `198.51.100.${i + 200}`,
                  i % 2,
                  undefined,
                  header,
                )
              ).data.code,
              'RECOVERY_DENIED',
            );
          assert.equal((await state(email)).failures, 5);
          assert.equal(
            (await request('/security/recover', body, '192.0.2.221', 1, undefined, header)).data
              .code,
            'CHALLENGE_EXHAUSTED_OR_EXPIRED',
          );
          const start = Date.now();
          const next = await request('/security/recovery-challenge', { email, purpose: 'code' });
          assert.ok(Date.now() - start >= 950);
          assert.equal(next.status, 200);
          await fixture.pool.query(
            "UPDATE auth_recovery_challenges SET expires_at=now()-interval '1 second' WHERE id=$1",
            [next.data.id],
          );
          assert.equal(
            (
              await request('/security/recover', body, '192.0.2.222', 1, undefined, {
                'x-memoria-recovery-challenge': String(next.data.id),
              })
            ).data.code,
            'CHALLENGE_EXHAUSTED_OR_EXPIRED',
          );
          const count = Number(
            (
              await fixture.pool.query(
                'SELECT attempts FROM auth_recovery_challenges WHERE id=$1',
                [challenge.data.id],
              )
            ).rows[0].attempts,
          );
          assert.equal(count, 5);
        },
      );
      await t.test(
        'native plugin ceilings cannot override the 300-per-route NAT limit',
        async () => {
          for (const path of [
            '/two-factor/verify-totp',
            '/passkey/verify-authentication',
            '/security/recovery-challenge',
          ]) {
            for (let i = 0; i < 300; i++)
              assert.notEqual(
                (await request(path, {}, '192.0.2.230', i % 2)).status,
                429,
                `${path} request ${i + 1}`,
              );
            assert.equal((await request(path, {}, '192.0.2.230')).status, 429, path);
          }
        },
      );
      await t.test(
        'expired failure windows and process-crash leases recover; retention is configurable',
        async () => {
          const person = await user(),
            key = accountKey(config.BETTER_AUTH_SECRET, person.email);
          await fixture.pool.query(
            "INSERT INTO auth_attempt_accounts(key,failures,started_at,touched_at) VALUES($1,10,now()-interval '16 minutes',now()-interval '25 hours')",
            [key],
          );
          await fixture.pool.query(
            "INSERT INTO auth_attempt_leases(id,account_key,lane,generation,ready_at,expires_at,started_at) VALUES($1,$2,'password',0,now()-interval '3 minutes',now()-interval '1 minute',now()-interval '2 minutes')",
            [randomUUID(), key],
          );
          const start = Date.now();
          assert.equal((await login(person.email)).status, 200);
          assert.ok(Date.now() - start < 2000);
          await fixture.pool.query(
            "UPDATE auth_attempt_accounts SET touched_at=now()-interval '2 hours' WHERE key=$1",
            [key],
          );
          process.env.AUTH_COUNTER_RETENTION_HOURS = '1';
          try {
            await purgeAuthCounters(db.db);
          } finally {
            delete process.env.AUTH_COUNTER_RETENTION_HOURS;
          }
          assert.equal(await state(person.email), undefined);
          assert.ok(
            Number(
              (
                await fixture.pool.query(
                  "SELECT count(*) n FROM auth_security_events WHERE action='account_throttle_threshold'",
                )
              ).rows[0].n,
            ) > 0,
          );
        },
      );
      await t.test(
        'global admission is bounded, releases slots, and SQL enforces the deadline independently of API clocks',
        async () => {
          const leases = await Promise.all(
            Array.from({ length: 128 }, () =>
              admitAttempt(
                db.db,
                accountKey(config.BETTER_AUTH_SECRET, randomUUID() + '@example.test'),
                'password',
              ),
            ),
          );
          try {
            const full = await login('queue-full@example.test', password, '192.0.2.241', 1);
            assert.equal(full.status, 429);
            assert.equal(full.data.code, 'AUTH_CAPACITY');
          } finally {
            await Promise.all(leases.map((lease) => finishAttempt(db.db, lease, false)));
          }
          assert.equal(
            (await login('queue-full@example.test', password, '192.0.2.241', 1)).status,
            401,
          );
          const own = await admitAttempt(
            db.db,
            accountKey(config.BETTER_AUTH_SECRET, randomUUID() + '@example.test'),
            'password',
          );
          try {
            // Even an erroneously early local wake-up must not start password work.
            await fixture.pool.query(
              "UPDATE auth_attempt_leases SET ready_at=clock_timestamp()+interval '1 second' WHERE id=$1",
              [own.id],
            );
            const start = Date.now();
            await waitAttempt(db.db, own, new AbortController().signal);
            assert.ok(Date.now() - start >= 950);
          } finally {
            await finishAttempt(db.db, own, false);
          }
        },
      );
      await t.test(
        'the general 600-per-route rule and reset 100-per-route rules remain active',
        async () => {
          for (const path of [
            '/get-session',
            '/security/request-password-reset',
            '/reset-password',
          ]) {
            const max = path === '/get-session' ? 600 : 100;
            for (let i = 0; i < max; i++)
              assert.notEqual(
                (
                  await request(
                    path,
                    path === '/get-session' ? undefined : {},
                    '192.0.2.242',
                    i % 2,
                  )
                ).status,
                429,
              );
            assert.equal(
              (await request(path, path === '/get-session' ? undefined : {}, '192.0.2.242')).status,
              429,
            );
          }
          assert.equal(
            ipKey(config.BETTER_AUTH_SECRET, '/sign-in/email', '::ffff:192.0.2.1'),
            ipKey(config.BETTER_AUTH_SECRET, '/sign-in/email', '192.0.2.1'),
          );
        },
      );
    } finally {
      for (const app of apps) await app.close();
      await db.pool.end();
      await fixture.close();
    }
  },
);
