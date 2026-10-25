import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { test } from 'node:test';
import { Controller, Get, Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDatabase } from '@memoria/db';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { ipKey } from '../../../packages/auth/src/throttle.ts';

// Deliberately has neither @Public nor @CurrentUser: only the real global guard
// can prevent this newly added handler from returning 200 to an anonymous caller.
@Controller('api/e2e/new-route')
class NewlyAddedController {
  @Get()
  handle() {
    return { reached: true };
  }
}

@Module({ imports: [AppModule], controllers: [NewlyAddedController] })
class E2eModule {}

const config = readConfig();
assert.notEqual(config.NODE_ENV, 'production');
assert.equal(config.APP_ORIGIN, 'https://localhost');
assert.equal(config.SMTP_HOST, '127.0.0.1');

await test(
  'Real Nest authentication boundary and PostgreSQL rate limits',
  { timeout: 60000 },
  async (t) => {
    const app = await NestFactory.create<NestExpressApplication>(E2eModule, {
      bodyParser: false,
      logger: false,
    });
    configureApplication(app);
    // Isolated listener: this test acts as the trusted proxy, using a fresh TEST-NET
    // IPv6 /64. It never resets counters belonging to Caddy or another developer.
    app.set('trust proxy', 'loopback');
    const hex = randomBytes(4).toString('hex');
    const ip = `2001:0db8:${hex.slice(0, 4)}:${hex.slice(4)}:0000:0000:0000:0000`;
    const paths = ['/sign-in/email', '/sign-up/email', '/send-verification-email', '/get-session'];
    const keys = paths.map((path) => ipKey(config.BETTER_AUTH_SECRET, path, ip));
    const { pool } = createDatabase(config.DATABASE_URL);
    try {
      await app.listen(0, '127.0.0.1');
      const origin = await app.getUrl();
      const request = (path: string, body?: unknown) =>
        globalThis.fetch(`${origin}${path}`, {
          method: body === undefined ? 'GET' : 'POST',
          headers: {
            Origin: config.APP_ORIGIN,
            'Content-Type': 'application/json',
            'x-forwarded-for': ip,
            // Changing this untrusted header must not evade the per-IP limit.
            'x-memoria-client-ip': `198.51.100.${randomBytes(1)[0]}`,
          },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        });

      await t.test('a newly added undecorated route is closed by default', async () => {
        assert.equal((await request('/api/e2e/new-route')).status, 401);
      });
      await t.test('explicit public health and Better Auth handlers remain reachable', async () => {
        assert.equal((await request('/api/health')).status, 200);
        assert.equal((await request('/api/auth/get-session')).status, 200);
        assert.equal((await request('/api/auth/organization/create', {})).status, 404);
      });
      await t.test(
        'login admits 150 attempts, returns 429 on the next and recovers after the fixed window',
        async () => {
          const body = { email: 'invalid' };
          for (let attempt = 0; attempt < 150; attempt++) {
            assert.equal((await request('/api/auth/sign-in/email', body)).status, 400);
          }
          const limited = await request('/api/auth/sign-in/email', body);
          assert.equal(limited.status, 429);
          const retry = Number(limited.headers.get('x-retry-after'));
          assert.ok(retry > 30 && retry <= 60);
          assert.equal((await request('/api/auth/get-session')).status, 200);
          // Advance only this fixture's persisted timestamp instead of sleeping a minute.
          const expired = await pool.query('update auth_buckets set started_at=$2 where key=$1', [
            keys[0],
            new Date(Date.now() - 61000),
          ]);
          assert.equal(expired.rowCount, 1);
          assert.equal((await request('/api/auth/sign-in/email', body)).status, 400);
        },
      );
      for (const [path, window, max] of [
        ['/sign-up/email', 600, 100],
        ['/send-verification-email', 300, 150],
      ] as const) {
        await t.test(`${path} blocks after ${max} requests independently`, async () => {
          // Invalid input exercises the real limiter without creating an account or sending mail.
          for (let attempt = 0; attempt < max; attempt++)
            assert.equal((await request(`/api/auth${path}`, { email: 'invalid' })).status, 400);
          const limited = await request(`/api/auth${path}`, { email: 'invalid' });
          assert.equal(limited.status, 429);
          const retry = Number(limited.headers.get('x-retry-after'));
          assert.ok(retry > window / 2 && retry <= window);
        });
      }
    } finally {
      try {
        await pool.query('delete from auth_buckets where key = any($1::text[])', [keys]);
      } finally {
        await pool.end();
        await app.close();
      }
    }
  },
);
