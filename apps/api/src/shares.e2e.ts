import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth, ipKey } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import {
  invitationSummarySchema,
  pageSharesSchema,
  accessPreviewSchema,
  pageSchema,
  collaborationAccessSchema,
  cachePolicySchema,
  pageAccessSnapshotSchema,
} from '@memoria/contracts';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { securityPeer } from '../../collab/src/testing/security-peer.ts';
import { measureRights } from './testing/rights-load.ts';
async function until(test: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await test())) {
    if (Date.now() > end) throw new Error('Timeout');
    await delay(20);
  }
}
await test(
  '5c real HTTP/WS: shares, previews, epochs and hostile callers',
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
    await app.listen(0, '127.0.0.1');
    const origin = await app.getUrl();
    const host = await collaborationServer(
      readCollabConfig({ ...process.env, COLLAB_PORT: '0', COLLAB_INTERNAL_PORT: '0' }),
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
    function browser() {
      const jar = new Map<string, string>();
      return {
        cookie: () => [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
        async call(
          path: string,
          body?: unknown,
          method = body === undefined ? 'GET' : 'POST',
          headers: Record<string, string> = {},
        ) {
          const response = await fetch(
            origin + (path.startsWith('/api/') ? path : '/api/auth' + path),
            {
              method,
              headers: {
                origin: config.APP_ORIGIN,
                'content-type': 'application/json',
                cookie: [...jar].map(([k, v]) => `${k}=${v}`).join('; '),
                'x-forwarded-for': '192.0.2.55',
                ...headers,
              },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            },
          );
          for (const c of response.headers.getSetCookie()) {
            const pair = c.split(';')[0]!,
              at = pair.indexOf('='),
              key = pair.slice(0, at),
              value = pair.slice(at + 1);
            if (value) jar.set(key, value);
            else jar.delete(key);
          }
          const data: unknown = method === 'HEAD' ? null : await response.json();
          return { status: response.status, data, headers: response.headers };
        },
      };
    }
    type Browser = ReturnType<typeof browser>;
    const ok = async (p: ReturnType<Browser['call']>, status = 200) => {
      const r = await p;
      assert.equal(r.status, status, JSON.stringify(r.data));
      return r.data as Record<string, unknown>;
    };
    async function account(verified = true) {
      const email = `${randomUUID()}@example.test`,
        password = randomBytes(18).toString('hex');
      const created = await fixtureAuth.api.signUpEmail({
        body: { email, password, name: 'Invite fixture' },
      });
      await db.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [
        created.user.id,
      ]);
      const b = browser();
      await ok(b.call('/sign-in/email', { email, password }));
      if (!verified)
        await db.pool.query('UPDATE auth_users SET email_verified=false WHERE id=$1', [
          created.user.id,
        ]);
      return { id: created.user.id, email, password, b, key: testAuthenticator() };
    }
    type Account = Awaited<ReturnType<typeof account>>;
    async function strong(a: Account, enroll = true) {
      if (enroll) {
        const opts = await ok(a.b.call('/passkey/generate-register-options'));
        await ok(
          a.b.call('/passkey/verify-registration', {
            response: a.key.register(String(opts.challenge)),
            name: 'Invitation test key',
          }),
        );
      }
      const opts = await ok(a.b.call('/passkey/generate-authenticate-options'));
      await ok(
        a.b.call('/passkey/verify-authentication', {
          response: a.key.authenticate(String(opts.challenge)),
        }),
      );
    }
    try {
      const owner = await account(),
        guest = await account(),
        admin = await account(),
        regular = await account(),
        outsider = await account();
      const workspace = String(
        (
          await ok(
            owner.b.call('/api/internal/workspaces', {
              name: '5c shares',
              slug: 'shares-' + randomUUID(),
            }),
            201,
          )
        ).id,
      );
      const base = `/api/internal/workspaces/${workspace}`;
      const create = async (title: string, parentId: string | null = null) =>
        pageSchema.parse(await ok(owner.b.call(base + '/pages', { title, parentId }), 201));
      const hidden = await create('Hidden parent'),
        root = await create('Shared root', hidden.id),
        child = await create('Descendant', root.id),
        other = await create('Elsewhere');
      await strong(owner);
      const grandchild = await create('Nested descendant', child.id);
      for (const [a, role] of [
        [guest, 'guest'],
        [admin, 'admin'],
        [regular, 'member'],
      ] as const) {
        const invitation = invitationSummarySchema.parse(
          await ok(
            owner.b.call(base + '/invitations', {
              email: a.email,
              role,
              roots: role === 'guest' ? [{ pageId: root.id, level: 'read' }] : [],
            }),
            201,
          ),
        );
        await ok(a.b.call('/api/internal/invitations/accept', { id: invitation.id }), 201);
      }
      const guestId = String(
        (
          await db.pool.query(
            'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
            [workspace, guest.id],
          )
        ).rows[0].id,
      );
      const list = async (a = owner, p = root.id) =>
        pageSharesSchema.parse(await ok(a.b.call(`${base}/pages/${p}/shares?limit=50`)));
      const share = async (level: 'read' | 'edit' | null, a = owner, version?: number) =>
        a.b.call(
          `${base}/pages/${root.id}/shares/${guestId}`,
          { level, expectedAccessVersion: version ?? (await list(a)).accessVersion },
          'PUT',
        );
      const open = async () =>
        collaborationAccessSchema.parse(
          await ok(guest.b.call(`${base}/pages/${child.id}/collaboration`, {}), 201),
        );
      await t.test(
        'S01/R12: each new route denies anonymous, outsider, guest; weak administrator guided by explicit proof error',
        async () => {
          const routes: [string, string, unknown?][] = [
            ['GET', `/pages/${root.id}/shares`],
            [
              'PUT',
              `/pages/${root.id}/shares/${guestId}`,
              { expectedAccessVersion: 1, level: 'edit' },
            ],
            [
              'POST',
              `/pages/${child.id}/move/preview`,
              { expectedVersion: 1, parentId: other.id, afterId: null },
            ],
            ['POST', `/pages/${child.id}/restore/preview`, { expectedVersion: 1 }],
          ];
          const passwordOnly = browser();
          await ok(
            passwordOnly.call('/sign-in/email', { email: owner.email, password: owner.password }),
          );
          for (const [method, path, body] of routes) {
            assert.equal((await browser().call(base + path, body, method)).status, 401, path);
            assert.equal(
              (await passwordOnly.call(base + path, body, method)).status,
              403,
              'restricted session ' + path,
            );
            assert(
              [403, 404].includes((await guest.b.call(base + path, body, method)).status),
              path,
            );
            assert(
              [403, 404].includes((await outsider.b.call(base + path, body, method)).status),
              path,
            );
          }
          const denied = await share('edit', admin);
          assert.equal(denied.status, 403);
          assert.equal((denied.data as { code: string }).code, 'RECENT_STRONG_AUTH_REQUIRED');
          assert.equal((await list()).guests[0]!.level, 'read');
          assert.equal(
            (await owner.b.call(`${base}/pages/${root.id}/shares?limit=101`)).status,
            400,
          );
        },
      );
      await t.test(
        'S02: admin strong proof, maximum inherited level, stale CAS and member isolation',
        async () => {
          await strong(admin);
          const stale = (await list()).accessVersion;
          await ok(share('edit', admin));
          assert.equal((await list(admin, child.id)).guests[0]!.level, 'edit');
          assert.equal((await share(null, owner, stale)).status, 409);
          const childState = await list(owner, child.id);
          await ok(
            owner.b.call(
              `${base}/pages/${child.id}/shares/${guestId}`,
              { expectedAccessVersion: childState.accessVersion, level: 'read' },
              'PUT',
            ),
          );
          const effective = (await list(owner, child.id)).guests[0]!;
          assert.equal(effective.direct, 'read');
          assert.equal(effective.level, 'edit');
          assert.equal(effective.sources.length, 2);
          assert.equal(
            (
              await owner.b.call(
                `${base}/pages/${child.id}/shares/${randomUUID()}`,
                { expectedAccessVersion: (await list()).accessVersion, level: 'edit' },
                'PUT',
              )
            ).status,
            404,
          );
          await ok(
            owner.b.call(
              `${base}/pages/${child.id}/shares/${guestId}`,
              { expectedAccessVersion: (await list()).accessVersion, level: null },
              'PUT',
            ),
          );
        },
      );
      await t.test(
        'C03: epoch-bound WebSocket closed after HTTP downgrade; old token cannot reconnect after regrant',
        async () => {
          const meta = await open();
          const token = JSON.stringify({
            ...meta.identity,
            scope: 'page',
            accessVersion: meta.accessVersion,
          });
          const legacy = securityPeer(
            host.ingress.url,
            meta.room,
            guest.b.cookie(),
            config.APP_ORIGIN,
            JSON.stringify(meta.identity),
          );
          peers.push(legacy);
          await until(() => legacy.closed || legacy.failed);
          assert(legacy.closed || legacy.failed, 'pre-epoch browser must reload');
          const p = securityPeer(
            host.ingress.url,
            meta.room,
            guest.b.cookie(),
            config.APP_ORIGIN,
            token,
          );
          peers.push(p);
          await until(() => p.provider.isSynced || p.failed);
          assert(!p.failed);
          await ok(share('read'));
          await until(() => p.closed);
          assert(p.closed);
          await ok(share('edit'));
          const newer = await open();
          assert(newer.accessVersion > meta.accessVersion);
          const old = securityPeer(
            host.ingress.url,
            meta.room,
            guest.b.cookie(),
            config.APP_ORIGIN,
            token,
          );
          peers.push(old);
          await until(() => old.closed || old.failed);
          assert(old.failed || old.closed);
          const policy = cachePolicySchema.parse(await ok(guest.b.call('/security/cache-policy')));
          assert.equal(
            policy.workspaces.find((w) => w.workspace === workspace)?.accessVersion,
            newer.accessVersion,
          );
        },
      );
      await t.test(
        'C04: unrelated archive and ineffective move preserve live sockets; actual loss closes only the affected guest/page',
        async () => {
          const unaffected = await create('Unrelated live document'),
            archived = await create('Archive without disturbing writers'),
            destination = await create('Move destination');
          const grant = async (level: 'read' | 'edit' | null) =>
            ok(
              owner.b.call(
                `${base}/pages/${unaffected.id}/shares/${guestId}`,
                {
                  expectedAccessVersion: (await list(owner, unaffected.id)).accessVersion,
                  level,
                },
                'PUT',
              ),
            );
          await grant('edit');
          const getMeta = async (a: Account) =>
            collaborationAccessSchema.parse(
              await ok(a.b.call(`${base}/pages/${unaffected.id}/collaboration`, {}), 201),
            );
          const guestBefore = await getMeta(guest),
            memberBefore = await getMeta(regular);
          const connect = async (a: Account, meta: typeof guestBefore) => {
            const peer = securityPeer(
              host.ingress.url,
              meta.room,
              a.b.cookie(),
              config.APP_ORIGIN,
              JSON.stringify({
                ...meta.identity,
                scope: 'page',
                accessVersion: meta.accessVersion,
              }),
            );
            peers.push(peer);
            await until(() => peer.provider.isSynced || peer.failed);
            assert(!peer.failed);
            return peer;
          };
          const guestPeer = await connect(guest, guestBefore),
            memberPeer = await connect(regular, memberBefore);
          await ok(
            owner.b.call(`${base}/pages/${archived.id}/archive`, {
              expectedVersion: archived.version,
            }),
            201,
          );
          const body = {
            expectedVersion: unaffected.version,
            parentId: destination.id,
            afterId: null,
          };
          const preview = accessPreviewSchema.parse(
            await ok(owner.b.call(`${base}/pages/${unaffected.id}/move/preview`, body), 201),
          );
          assert.deepEqual(preview.effects, []);
          await ok(
            owner.b.call(`${base}/pages/${unaffected.id}/move`, {
              ...body,
              previewToken: preview.token,
            }),
            201,
          );
          await delay(5200); // Observe the fallback check as well as NOTIFY.
          assert(
            !memberPeer.closed && !guestPeer.closed,
            'unchanged effective access must keep both sockets',
          );
          assert.equal((await getMeta(regular)).accessVersion, memberBefore.accessVersion);
          assert.equal((await getMeta(guest)).accessVersion, guestBefore.accessVersion);
          const beforeLoss = Date.now();
          await grant(null);
          await until(() => guestPeer.closed);
          assert(
            Date.now() - beforeLoss < 5000,
            'actual loss must close within the existing bound',
          );
          assert(!memberPeer.closed, 'another user on the same page is not revoked');
          assert.equal((await getMeta(regular)).accessVersion, memberBefore.accessVersion);
          const snapshot = pageAccessSnapshotSchema.parse(
            await ok(guest.b.call(`${base}/page-access`)),
          );
          assert(
            !snapshot.pages.some((p) => [unaffected.id, hidden.id, other.id].includes(p.page)),
          );
          assert.equal((await browser().call(`${base}/page-access`)).status, 401);
          assert.equal((await outsider.b.call(`${base}/page-access`)).status, 404);
          const restricted = browser();
          await ok(
            restricted.call('/sign-in/email', { email: owner.email, password: owner.password }),
          );
          assert.equal((await restricted.call(`${base}/page-access`)).status, 403);
          memberPeer.destroy();
          guestPeer.destroy();
        },
      );
      await t.test(
        'M01: preview matches actual inherited losses/gains; stale/forged/misbound preview fails',
        async () => {
          const body = { expectedVersion: 1, parentId: other.id, afterId: null };
          const preview = accessPreviewSchema.parse(
            await ok(owner.b.call(`${base}/pages/${child.id}/move/preview`, body), 201),
          );
          assert.deepEqual(
            preview.effects.map((e) => e.changes),
            [[{ from: 'edit', to: 'none', count: 2 }]],
          );
          assert.equal(
            (
              await owner.b.call(`${base}/pages/${child.id}/move`, {
                ...body,
                previewToken: '0'.repeat(64),
              })
            ).status,
            409,
          );
          assert.equal(
            (
              await owner.b.call(`${base}/pages/${root.id}/move`, {
                ...body,
                previewToken: preview.token,
              })
            ).status,
            409,
          );
          await ok(share('read'));
          assert.equal(
            (
              await owner.b.call(`${base}/pages/${child.id}/move`, {
                ...body,
                previewToken: preview.token,
              })
            ).status,
            409,
          );
          const fresh = accessPreviewSchema.parse(
            await ok(owner.b.call(`${base}/pages/${child.id}/move/preview`, body), 201),
          );
          const moved = pageSchema.parse(
            await ok(
              owner.b.call(`${base}/pages/${child.id}/move`, {
                ...body,
                previewToken: fresh.token,
              }),
              201,
            ),
          );
          assert.equal((await guest.b.call(`${base}/pages/${child.id}`)).status, 404);
          assert.equal((await guest.b.call(`${base}/pages/${grandchild.id}`)).status, 404);
          const back = { expectedVersion: moved.version, parentId: root.id, afterId: null };
          const returning = accessPreviewSchema.parse(
            await ok(owner.b.call(`${base}/pages/${child.id}/move/preview`, back), 201),
          );
          assert.deepEqual(returning.effects[0]!.changes, [{ from: 'none', to: 'read', count: 2 }]);
          const returned = pageSchema.parse(
            await ok(
              owner.b.call(`${base}/pages/${child.id}/move`, {
                ...back,
                previewToken: returning.token,
              }),
              201,
            ),
          );
          assert.equal((await open()).level, 'read');
          const archived = pageSchema.parse(
            await ok(
              owner.b.call(`${base}/pages/${child.id}/archive`, {
                expectedVersion: returned.version,
              }),
              201,
            ),
          );
          const restore = { expectedVersion: archived.version };
          const restored = accessPreviewSchema.parse(
            await ok(owner.b.call(`${base}/pages/${child.id}/restore/preview`, restore), 201),
          );
          assert.deepEqual(restored.effects[0]!.changes, [{ from: 'none', to: 'read', count: 2 }]);
          await ok(
            owner.b.call(`${base}/pages/${child.id}/restore`, {
              ...restore,
              previewToken: restored.token,
            }),
            201,
          );
          assert.equal((await open()).level, 'read');
          await ok(
            owner.b.call(
              `${base}/pages/${child.id}/shares/${guestId}`,
              { expectedAccessVersion: (await list()).accessVersion, level: 'read' },
              'PUT',
            ),
          );
          const current = await ok(owner.b.call(`${base}/pages/${child.id}/version`));
          const directMove = {
            expectedVersion: current.version,
            parentId: other.id,
            afterId: null,
          };
          const directPreview = accessPreviewSchema.parse(
            await ok(owner.b.call(`${base}/pages/${child.id}/move/preview`, directMove), 201),
          );
          assert.deepEqual(
            directPreview.effects,
            [],
            'direct grant follows its page and descendants',
          );
          await ok(
            owner.b.call(`${base}/pages/${child.id}/move`, {
              ...directMove,
              previewToken: directPreview.token,
            }),
            201,
          );
          assert.equal((await open()).level, 'read');
          assert.equal((await guest.b.call(`${base}/pages/${grandchild.id}`)).status, 200);
        },
      );
      if (process.env.MEMORIA_MEASURE_RIGHTS === 'true') {
        await db.pool.query('TRUNCATE auth_buckets');
        await t.test('5d measurement: 1000 pages and four writers during share/role/removal', () =>
          measureRights(
            db.pool,
            owner.b.call,
            owner.b.cookie(),
            host.ingress.url,
            config.APP_ORIGIN,
          ),
        );
      }
      await t.test(
        'Q02: canonical quotas cover all five new routes; forged IP cannot reset the bucket',
        async () => {
          app.set('trust proxy', false);
          const routes: [string, string, string, unknown?][] = [
            ['GET', 'access:read', '/pages/:pageId/shares'],
            ['GET', 'content:read', '/page-access'],
            [
              'PUT',
              'access:mutate',
              '/pages/:pageId/shares/:memberId',
              { expectedAccessVersion: 1, level: 'edit' },
            ],
            [
              'POST',
              'content:read',
              '/pages/:pageId/move/preview',
              { expectedVersion: 1, parentId: null, afterId: null },
            ],
            ['POST', 'content:read', '/pages/:pageId/restore/preview', { expectedVersion: 1 }],
          ];
          for (const [method, family, route, body] of routes) {
            const template = '/api/internal/workspaces/:workspaceId' + route;
            const key = ipKey(config.BETTER_AUTH_SECRET, `${family}:${template}`, '127.0.0.1');
            await db.pool.query(
              'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,4000,now(),now()) ON CONFLICT(key) DO UPDATE SET count=4000,started_at=now()',
              [key],
            );
            const url = base + route.replace(':pageId', root.id).replace(':memberId', guestId);
            assert.equal(
              (
                await owner.b.call(url, body, method, {
                  'x-forwarded-for': '203.0.113.47',
                  'x-memoria-client-ip': '203.0.113.48',
                })
              ).status,
              429,
              route,
            );
          }
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
