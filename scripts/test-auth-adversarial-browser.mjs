import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { build, stop } from 'esbuild';
import { chromium } from '@playwright/test';
import { testOtp } from '../packages/auth/src/testing/otp.ts';

const origin = process.env.APP_ORIGIN;
if (origin !== 'https://localhost' || process.env.NODE_ENV === 'production')
  throw new Error('Local development only');
const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
// Exact production cache code, in real Chromium IndexedDB. No mock of HTTP policy or IDB.
const compiled = await build({
  entryPoints: ['apps/web/src/lib/yjs-cache.ts'],
  bundle: true,
  format: 'iife',
  globalName: 'MemoriaCacheAttack',
  platform: 'browser',
  write: false,
});
stop();
await test(
  '4f HTTPS attacks: delayed policy, removed member, queued cache writes and forged proxy headers',
  { timeout: 120000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const owner = await browser.newContext(),
      member = await browser.newContext();
    const users = [],
      workspaces = [];
    const password = randomBytes(24).toString('base64url');
    async function request(
      context,
      path,
      data,
      method = data === undefined ? 'GET' : 'POST',
      headers = {},
    ) {
      const r = await context.request.fetch(
        origin + (path.startsWith('/api/') ? path : '/api/auth' + path),
        {
          method,
          headers: { Origin: origin, ...headers },
          ...(data === undefined ? {} : { data }),
        },
      );
      return { status: r.status(), data: await r.json() };
    }
    async function ok(p, status = 200) {
      const r = await p;
      assert.equal(r.status, status, 'Unexpected status; response intentionally omitted');
      return r.data;
    }
    async function account(context) {
      const email = 'adverse4f-' + randomUUID() + '@example.test';
      const id = (
        await ok(request(context, '/sign-up/email', { email, password, name: 'Adverse browser' }))
      ).user.id;
      users.push(id);
      await pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [id]);
      await ok(request(context, '/sign-in/email', { email, password }));
      return id;
    }
    try {
      const ownerId = await account(owner),
        memberId = await account(member);
      const uri = (await ok(request(owner, '/two-factor/enable', { password }))).totpURI;
      const otp = testOtp(uri),
        step = Math.floor(Date.now() / 30000);
      for (const s of [step - 1, step]) {
        const challenge = await ok(request(owner, '/security/challenge', {}));
        await ok(
          request(owner, '/two-factor/verify-totp', { code: await otp.hotp(s) }, 'POST', {
            'x-memoria-challenge': challenge.id,
          }),
        );
      }
      const workspace = (
        await ok(
          request(owner, '/api/internal/workspaces', { name: 'Adverse cache', slug: randomUUID() }),
          201,
        )
      ).id;
      workspaces.push(workspace);
      await pool.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
        [workspace, memberId],
      );
      await pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        memberId,
      ]);
      const base = `/api/internal/workspaces/${workspace}`;
      const pageId = (
        await ok(
          request(owner, base + '/pages', { title: 'Adverse unchanged', parentId: null }),
          201,
        )
      ).id;
      const generation = (
        await ok(request(member, `${base}/pages/${pageId}/collaboration`, {}), 201)
      ).generation;
      const page = await member.newPage();
      await page.goto(origin + '/connexion');
      // Remove unrelated UI polling; the browser still uses the real origin and its real cookies.
      await page.route('**/api/auth/security/cache-policy', (route) => route.abort());
      await page.addScriptTag({ content: compiled.outputFiles[0].text });
      const snapshot = await ok(request(member, '/security/cache-policy'));
      const init = { snapshot, workspace, pageId, generation };
      await page.evaluate(async ({ snapshot, workspace, pageId, generation }) => {
        const store = globalThis.MemoriaCacheAttack.yjsCache;
        const ticket = await store.ticket(snapshot.user, snapshot.session);
        const allowed = await store.applyPolicy(ticket, snapshot);
        const opened = await store.open(allowed, workspace, pageId, generation);
        // Empty valid Yjs update plus an outstanding receipt is sufficient to observe resurrection.
        await store.append(allowed, opened.page, new Uint8Array([0, 0]), 'offline-receipt');
        globalThis.cacheAttack = {
          store,
          allowed,
          opened,
          late: await store.ticket(snapshot.user, snapshot.session),
        };
      }, init);
      await ok(
        request(
          owner,
          base + '/security',
          {
            expectedVersion: 1,
            requireStrongAuth: false,
            graceDays: 7,
            allowPersistentCache: false,
          },
          'PUT',
        ),
      );
      const banned = await ok(request(member, '/security/cache-policy'));
      const attempt = async (decision, old) =>
        page.evaluate(
          async ({ decision, old, workspace, pageId, generation }) => {
            const { store, allowed, opened, late } = globalThis.cacheAttack;
            await store.applyPolicy(await store.ticket(decision.user, decision.session), decision);
            const stale = await store.applyPolicy(late, old);
            let oldWriteRejected = false,
              staleOpenRejected = false;
            try {
              await store.append(allowed, opened.page, new Uint8Array([0, 0]), 'resurrect');
            } catch {
              oldWriteRejected = true;
            }
            try {
              await store.open(stale, workspace, pageId, generation);
            } catch {
              staleOpenRejected = true;
            }
            return {
              oldWriteRejected,
              staleOpenRejected,
              pending: await store.pending(decision.user),
            };
          },
          { decision, old, workspace, pageId, generation },
        );
      assert.deepEqual(await attempt(banned, snapshot), {
        oldWriteRejected: true,
        staleOpenRejected: true,
        pending: 0,
      });
      console.log(
        'PASS B01 real HTTP cache ban, delayed pre-ban response and queued write cannot recreate local content',
      );
      await ok(
        request(
          owner,
          base + '/security',
          {
            expectedVersion: 2,
            requireStrongAuth: false,
            graceDays: 7,
            allowPersistentCache: true,
          },
          'PUT',
        ),
      );
      const restored = await ok(request(member, '/security/cache-policy'));
      await page.evaluate(
        async ({ snapshot, workspace, pageId, generation }) => {
          const { store } = globalThis.cacheAttack;
          const allowed = await store.applyPolicy(
            await store.ticket(snapshot.user, snapshot.session),
            snapshot,
          );
          const opened = await store.open(allowed, workspace, pageId, generation);
          await store.append(
            allowed,
            opened.page,
            new Uint8Array([0, 0]),
            'pending-removed-member',
          );
          globalThis.cacheAttack = {
            store,
            allowed,
            opened,
            late: await store.ticket(snapshot.user, snapshot.session),
          };
        },
        { ...init, snapshot: restored },
      );
      // Membership management UI is session 5. This SQL fixture performs the same real revocation.
      await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
        workspace,
        memberId,
      ]);
      const removed = await ok(request(member, '/security/cache-policy'));
      assert(!removed.workspaces.some((w) => w.workspace === workspace));
      assert.deepEqual(await attempt(removed, restored), {
        oldWriteRejected: true,
        staleOpenRejected: true,
        pending: 0,
      });
      assert.equal(
        (await request(member, `${base}/pages/${pageId}/collaboration`, {})).status,
        403,
      );
      console.log(
        'PASS B02 real membership revocation, same policy version, stale allowed response cannot resurrect the cache',
      );

      // Actual Caddy, not a trusted-proxy mock: all forged forwarding values must hit ONE bucket.
      const before = new Map(
        (await pool.query('SELECT key,count FROM auth_buckets')).rows.map((r) => [r.key, r.count]),
      );
      for (let i = 0; i < 8; i++) {
        assert.equal(
          (
            await request(member, '/sign-in/email', { email: 'invalid', password }, 'POST', {
              'x-forwarded-for': `203.0.113.${i + 1}`,
              'x-real-ip': `198.51.100.${i + 1}`,
              'x-memoria-client-ip': `2001:db8:${i}::1`,
              Forwarded: `for=192.0.2.${i + 1}`,
            })
          ).status,
          400,
        );
      }
      const changed = (await pool.query('SELECT key,count FROM auth_buckets')).rows.filter(
        (r) => r.count !== (before.get(r.key) ?? 0),
      );
      assert.equal(changed.length, 1, 'Forged headers created multiple proxy identities');
      assert.equal(changed[0].count - (before.get(changed[0].key) ?? 0), 8);
      console.log(
        'PASS B03 eight forged forwarding identities through actual HTTPS Caddy consumed one IP bucket',
      );
      assert(users.includes(ownerId));
    } finally {
      await browser.close();
      for (const id of workspaces) await pool.query('DELETE FROM workspaces WHERE id=$1', [id]);
      for (const id of users) await pool.query('DELETE FROM auth_users WHERE id=$1', [id]);
      await pool.end();
    }
  },
);
