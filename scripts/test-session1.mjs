import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { request } from 'node:https';
import { setTimeout } from 'node:timers/promises';
import { test } from 'node:test';
import { createDatabase } from '../packages/db/src/client.ts';

const origin = process.env.APP_ORIGIN;
if (
  process.env.NODE_ENV === 'production' ||
  origin !== 'https://localhost' ||
  process.env.SMTP_HOST !== '127.0.0.1'
) {
  throw new Error('This fixture test requires the local Caddy/PostgreSQL/Mailpit environment');
}
const ca = readFileSync(new URL('../.local-root.crt', import.meta.url));
const { pool } = createDatabase(process.env.DATABASE_URL);
const fixture = randomUUID();
const emails = [`session1-${fixture}@example.test`, `other-${fixture}@example.test`];
const slugs = [`studio-${fixture}`, `race-${fixture}`];
const messageIds = [];
const password = randomBytes(24).toString('base64url');
const cookies = new Map();

function http(path, { method = 'GET', body, jar = cookies, originHeader = origin } = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      new URL(path, origin),
      {
        ca,
        method,
        timeout: 15000,
        headers: {
          ...(originHeader === null ? {} : { Origin: originHeader }),
          ...(payload ? { 'Content-Type': 'application/json' } : {}),
          ...(jar.size
            ? { Cookie: [...jar].map(([key, value]) => `${key}=${value}`).join('; ') }
            : {}),
        },
      },
      (response) => {
        const setCookies = response.headers['set-cookie'] ?? [];
        for (const cookie of setCookies) {
          const pair = cookie.split(';')[0];
          const separator = pair.indexOf('=');
          jar.set(pair.slice(0, separator), pair.slice(separator + 1));
        }
        let text = '';
        response.setEncoding('utf8');
        response.on('data', (chunk) => {
          text += chunk;
        });
        response.on('end', () => {
          let data;
          try {
            data = JSON.parse(text);
          } catch {
            data = text;
          }
          resolve({ status: response.statusCode, data, setCookies, headers: response.headers });
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('HTTP test timeout')));
    req.end(payload);
  });
}

async function verificationLink(email) {
  for (let attempt = 0; attempt < 20; attempt++) {
    const response = await globalThis.fetch(
      `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent(`to:${email}`)}`,
    );
    const result = await response.json();
    const message = result.messages?.find((entry) =>
      entry.To?.some((recipient) => recipient.Address === email),
    );
    if (message) {
      messageIds.push(message.ID);
      const detail = await (
        await globalThis.fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)
      ).json();
      const link = detail.Text.match(/https:\/\/localhost\/api\/auth\/verify-email\?[^\s]+/)?.[0];
      assert.ok(link, 'Mailpit must contain a verification link');
      return link;
    }
    await setTimeout(250);
  }
  throw new Error('No verification email received in Mailpit');
}

await test(
  'Session 1 through Caddy HTTPS, real PostgreSQL and Mailpit',
  { timeout: 90000 },
  async (t) => {
    try {
      await t.test('web, API and worker are reachable with a trusted TLS certificate', async () => {
        assert.equal((await http('/api/health')).status, 200);
        assert.equal((await http('/api/health/worker')).status, 200);
        assert.equal((await http('/connexion')).status, 200);
        assert.equal((await http('/api/internal/workspaces')).status, 401);
      });
      await t.test(
        'signup sends an email and cannot authenticate before verification',
        async () => {
          const signup = await http('/api/auth/sign-up/email', {
            method: 'POST',
            body: {
              name: 'Session test',
              email: emails[0],
              password,
              callbackURL: '/connexion?verified=1',
            },
          });
          assert.equal(signup.status, 200);
          assert.equal(cookies.size, 0, 'Signup must not create a logged-in session');
          const login = await http('/api/auth/sign-in/email', {
            method: 'POST',
            body: { email: emails[0], password },
          });
          assert.equal(login.status, 403);
          assert.equal(login.data.code, 'EMAIL_NOT_VERIFIED');
          assert.equal((await http('/api/internal/workspaces')).status, 401);
        },
      );
      await t.test(
        'verification permits login with a Secure, HttpOnly, host-only cookie',
        async () => {
          const verified = await http(await verificationLink(emails[0]), { originHeader: null });
          assert.equal(verified.status, 302);
          const login = await http('/api/auth/sign-in/email', {
            method: 'POST',
            body: { email: emails[0], password },
          });
          assert.equal(login.status, 200);
          const cookie = login.setCookies.find((value) => value.includes('session_token='));
          assert.ok(cookie, 'A session cookie must be set');
          assert.match(cookie, /;\s*Secure/i);
          assert.match(cookie, /;\s*HttpOnly/i);
          assert.match(cookie, /;\s*SameSite=Lax/i);
          assert.doesNotMatch(cookie, /;\s*Domain=/i);
          assert.equal((await http('/api/auth/get-session')).data.user.emailVerified, true);
        },
      );
      await t.test(
        'CSRF, direct plugin mutations and client-supplied roles are rejected',
        async () => {
          const body = { name: 'Test studio', slug: slugs[0] };
          assert.equal(
            (
              await http('/API/INTERNAL/workspaces', {
                method: 'POST',
                body,
                originHeader: 'https://untrusted.example',
              })
            ).status,
            403,
          );
          assert.equal(
            (await http('/api/internal/workspaces', { method: 'POST', body, originHeader: null }))
              .status,
            403,
          );
          assert.equal(
            (
              await http('/api/internal/workspaces', {
                method: 'POST',
                body,
                originHeader: 'https://untrusted.example',
              })
            ).status,
            403,
          );
          assert.equal(
            (await http('/api/auth/organization/create', { method: 'POST', body })).status,
            404,
          );
          assert.equal(
            (await http('/api/auth/two-factor/enable', { method: 'POST', body: {} })).status,
            404,
          );
          assert.equal(
            (
              await http('/api/internal/workspaces', {
                method: 'POST',
                body: { ...body, role: 'admin' },
              })
            ).status,
            400,
          );
        },
      );
      await t.test('workspace creation persists owner and initialization atomically', async () => {
        const created = await http('/api/internal/workspaces', {
          method: 'POST',
          body: { name: 'Test studio', slug: slugs[0] },
        });
        assert.equal(created.status, 201);
        assert.equal(created.data.role, 'owner');
        assert.ok(
          (await http('/api/internal/workspaces')).data.some(
            (workspace) => workspace.id === created.data.id,
          ),
        );
        const check = await pool.query(
          `select count(*)::int as count from workspaces w
        join workspace_members m on m.workspace_id=w.id and m.role='owner'
        join workspace_policies p on p.workspace_id=w.id
        join access_subjects s on s.member_id=m.id
        join audit_logs a on a.workspace_id=w.id and a.action='workspace.created'
        where w.id=$1`,
          [created.data.id],
        );
        assert.equal(check.rows[0].count, 1);
      });
      await t.test(
        'a concurrent slug collision returns one creation and one conflict',
        async () => {
          const attempts = await Promise.all(
            [1, 2].map(() =>
              http('/api/internal/workspaces', {
                method: 'POST',
                body: { name: 'Concurrent studio', slug: slugs[1] },
              }),
            ),
          );
          assert.deepEqual(attempts.map((result) => result.status).sort(), [201, 409]);
          const count = await pool.query(
            'select count(*)::int as count from workspaces where slug=$1',
            [slugs[1]],
          );
          assert.equal(count.rows[0].count, 1);
        },
      );
      await t.test('another verified account cannot see the first user’s workspaces', async () => {
        const other = new Map();
        assert.equal(
          (
            await http('/api/auth/sign-up/email', {
              method: 'POST',
              jar: other,
              body: { name: 'Other test', email: emails[1], password },
            })
          ).status,
          200,
        );
        assert.equal(
          (await http(await verificationLink(emails[1]), { jar: other, originHeader: null }))
            .status,
          302,
        );
        assert.equal(
          (
            await http('/api/auth/sign-in/email', {
              method: 'POST',
              jar: other,
              body: { email: emails[1], password },
            })
          ).status,
          200,
        );
        assert.deepEqual((await http('/api/internal/workspaces', { jar: other })).data, []);
      });
      await t.test('signout revokes the session, including replay of the old cookie', async () => {
        const stale = new Map(cookies);
        assert.equal((await http('/api/auth/sign-out', { method: 'POST', body: {} })).status, 200);
        assert.equal((await http('/api/internal/workspaces', { jar: stale })).status, 401);
      });
    } finally {
      // Only this run's exact random fixture identifiers, never a database reset.
      await pool.query('delete from workspaces where slug = any($1::text[])', [slugs]);
      await pool.query('delete from auth_users where email = any($1::text[])', [emails]);
      await pool.end();
      for (const id of new Set(messageIds))
        await globalThis.fetch(`http://127.0.0.1:8025/api/v1/messages`, {
          method: 'DELETE',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ IDs: [id] }),
        });
    }
  },
);
