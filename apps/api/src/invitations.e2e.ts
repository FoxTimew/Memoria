import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth, processAuthMail, purgeInvitations, ipKey, throttleKey } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import { invitationSummarySchema, arrivalSchema } from '@memoria/contracts';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { testAuthenticator } from './testing/webauthn.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { securityPeer } from '../../collab/src/testing/security-peer.ts';
async function until(test: () => boolean | Promise<boolean>) {
  const end = Date.now() + 10000;
  while (!(await test())) {
    if (Date.now() > end) throw new Error('Timeout');
    await delay(20);
  }
}
await test(
  '5b real HTTP: invitations, current authority, transactional acceptance and MFA arrival',
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
    const resetQuotas = () => db.pool.query('TRUNCATE auth_buckets');
    try {
      const owner = await account(),
        admin = await account(),
        guest = await account(),
        wrong = await account(),
        unverified = await account(false);
      const workspace = String(
          (
            await ok(
              owner.b.call('/api/internal/workspaces', {
                name: 'Invitations test',
                slug: 'invite-' + randomUUID(),
              }),
              201,
            )
          ).id,
        ),
        base = `/api/internal/workspaces/${workspace}`;
      const page = String(
        (await ok(owner.b.call(base + '/pages', { title: 'Shared root', parentId: null }), 201)).id,
      );
      const invite = (a: Account, email: string, role = 'member', roots: unknown[] = []) =>
        a.b.call(base + '/invitations', { email, role, roots });
      const accept = (a: Account, id: string) =>
        a.b.call('/api/internal/invitations/accept', { id });
      const summary = (data: unknown) => invitationSummarySchema.parse(data);
      let adminMember = '';
      await t.test(
        'I04: no factor/recent proof blocks even optional workspace; enrollment alone is not assurance',
        async () => {
          const denied = await invite(owner, guest.email, 'guest', [
            { pageId: page, level: 'read' },
          ]);
          assert.equal(denied.status, 403);
          assert.equal((denied.data as { code: string }).code, 'RECENT_STRONG_AUTH_REQUIRED');
          const opts = await ok(owner.b.call('/passkey/generate-register-options'));
          await ok(
            owner.b.call('/passkey/verify-registration', {
              response: owner.key.register(String(opts.challenge)),
              name: 'Owner key',
            }),
          );
          assert.equal((await invite(owner, guest.email)).status, 403);
          await strong(owner, false);
          const sent = summary(await ok(invite(owner, admin.email, 'admin'), 201));
          await ok(accept(admin, sent.id), 201);
          adminMember = (
            await db.pool.query(
              'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
              [workspace, admin.id],
            )
          ).rows[0].id;
          assert.equal((await invite(admin, guest.email)).status, 403);
          await strong(admin);
        },
      );
      let invitationId = '';
      await t.test(
        'I01/I04: exact verified recipient, strict roles/roots and native route denial',
        async () => {
          for (const role of ['owner', 'owner,member', ['member', 'admin']])
            assert.equal(
              (await owner.b.call(base + '/invitations', { email: guest.email, role })).status,
              400,
            );
          assert.equal((await invite(admin, wrong.email, 'admin')).status, 403);
          assert.equal((await invite(wrong, guest.email)).status, 404);
          assert.equal((await invite(owner, guest.email, 'guest', [])).status, 400);
          assert.equal(
            (await invite(owner, guest.email, 'guest', [{ pageId: db.page, level: 'edit' }]))
              .status,
            404,
          );
          const sent = summary(
            await ok(invite(admin, guest.email, 'guest', [{ pageId: page, level: 'edit' }]), 201),
          );
          invitationId = sent.id;
          assert.equal(sent.deliveryStatus, 'queued');
          assert(sent.link?.includes('/invitation#id='));
          const anonymous = browser();
          assert.equal(
            (await anonymous.call('/api/internal/invitations/resolve', { id: sent.id })).status,
            401,
          );
          assert.equal(
            (await wrong.b.call('/api/internal/invitations/resolve', { id: sent.id })).status,
            404,
          );
          assert.equal(
            (await unverified.b.call('/api/internal/invitations/resolve', { id: sent.id })).status,
            403,
          );
          assert.equal((await accept(wrong, sent.id)).status, 404);
          const resolved = await ok(
            guest.b.call('/api/internal/invitations/resolve', { id: sent.id }),
            201,
          );
          assert(!('email' in resolved) && !('roots' in resolved));
          assert.equal(
            (await guest.b.call('/organization/accept-invitation', { invitationId: sent.id }))
              .status,
            404,
          );
          assert.equal((await owner.b.call(base + '/invitations?limit=101')).status, 400);
        },
      );
      await t.test(
        'I03: real HTTP audit failure rolls back native accepted status, membership, actor, grants and mail',
        async () => {
          await db.pool.query(
            `CREATE FUNCTION fail_invitation_audit() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='invitation.accepted' THEN RAISE EXCEPTION 'test failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_invitation_audit BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_invitation_audit()`,
          );
          assert.equal((await accept(guest, invitationId)).status, 500);
          assert.equal(
            (
              await db.pool.query('SELECT status FROM workspace_invitations WHERE id=$1', [
                invitationId,
              ])
            ).rows[0].status,
            'pending',
          );
          for (const table of ['workspace_members', 'actors'])
            assert.equal(
              (
                await db.pool.query(
                  `SELECT count(*) n FROM ${table} WHERE workspace_id=$1 AND user_id=$2`,
                  [workspace, guest.id],
                )
              ).rows[0].n,
              '0',
            );
          assert.equal(
            (
              await db.pool.query('SELECT count(*) n FROM auth_mail_jobs WHERE user_id=$1', [
                guest.id,
              ])
            ).rows[0].n,
            '0',
          );
          await db.pool.query(
            'DROP TRIGGER fail_invitation_audit ON audit_logs; DROP FUNCTION fail_invitation_audit()',
          );
          const both = await Promise.all([
            accept(guest, invitationId),
            accept(guest, invitationId),
          ]);
          assert.deepEqual(both.map((r) => r.status).sort(), [201, 404]);
          assert.equal(
            (
              await db.pool.query(
                'SELECT count(*) n FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
                [workspace, guest.id],
              )
            ).rows[0].n,
            '1',
          );
          assert.equal((await invite(owner, guest.email)).status, 409);
          await ok(guest.b.call(`${base}/pages/${page}`));
        },
      );
      await t.test(
        'I02/I03: resend rotates link, duplicate creation and terminal/expired links do not create access',
        async () => {
          const next = await account();
          const a = summary(await ok(invite(owner, next.email), 201));
          const duplicate = await invite(owner, next.email);
          assert.equal(duplicate.status, 409);
          const b = summary(await ok(owner.b.call(`${base}/invitations/${a.id}/resend`, {}), 201));
          assert.notEqual(a.id, b.id);
          assert.equal((await accept(next, a.id)).status, 404);
          await ok(owner.b.call(`${base}/invitations/${b.id}/cancel`, {}), 201);
          assert.equal((await accept(next, b.id)).status, 404);
          const c = summary(await ok(invite(owner, next.email), 201));
          await db.pool.query(
            "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
            [c.id],
          );
          assert.equal((await accept(next, c.id)).status, 404);
          const d = summary(await ok(invite(owner, next.email), 201));
          await ok(next.b.call('/api/internal/invitations/reject', { id: d.id }), 201);
          assert.equal((await accept(next, d.id)).status, 404);
          const e = summary(await ok(invite(owner, next.email), 201));
          const race = await Promise.all([
            owner.b.call(`${base}/invitations/${e.id}/cancel`, {}),
            accept(next, e.id),
          ]);
          assert.equal(race.filter((r) => r.status === 201).length, 1);
          assert.equal(race.filter((r) => r.status === 404).length, 1);
        },
      );
      await t.test(
        'I04/A03: admin cannot target privileged roles; owner promotion clears grants; removal closes actual sockets',
        async () => {
          const ownerMember = (
            await db.pool.query(
              'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
              [workspace, owner.id],
            )
          ).rows[0].id;
          const guestMember = (
            await db.pool.query(
              'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
              [workspace, guest.id],
            )
          ).rows[0].id;
          for (const [target, expectedRole, role] of [
            [ownerMember, 'owner', 'member'],
            [adminMember, 'admin', 'member'],
            [guestMember, 'guest', 'admin'],
          ])
            assert.equal(
              (await admin.b.call(`${base}/members/${target}/role`, { expectedRole, role }, 'PUT'))
                .status,
              403,
            );
          assert.equal(
            (
              await owner.b.call(
                `${base}/members/${ownerMember}`,
                { expectedRole: 'owner' },
                'DELETE',
              )
            ).status,
            409,
          );
          const policy = await ok(admin.b.call(base + '/security'));
          await ok(
            admin.b.call(
              base + '/security',
              { expectedVersion: policy.version, allowPersistentCache: false },
              'PUT',
            ),
          );
          assert.equal(
            (
              await admin.b.call(
                base + '/security',
                {
                  expectedVersion: Number(policy.version) + 1,
                  allowPersistentCache: true,
                  requireStrongAuth: false,
                  graceDays: 7,
                },
                'PUT',
              )
            ).status,
            403,
          );
          assert.equal((await ok(admin.b.call(base + '/security'))).allowPersistentCache, false);
          await ok(
            owner.b.call(
              `${base}/members/${guestMember}/role`,
              { expectedRole: 'guest', role: 'member' },
              'PUT',
            ),
          );
          assert.equal(
            (
              await db.pool.query(
                'SELECT count(*) n FROM access_grants g JOIN access_subjects s ON s.id=g.subject_id WHERE s.member_id=$1',
                [guestMember],
              )
            ).rows[0].n,
            '0',
          );
          assert.equal(
            (
              await owner.b.call(
                `${base}/members/${guestMember}/role`,
                { expectedRole: 'member', role: 'guest' },
                'PUT',
              )
            ).status,
            400,
          );
          await ok(
            owner.b.call(
              `${base}/members/${guestMember}/role`,
              { expectedRole: 'member', role: 'guest', roots: [{ pageId: page, level: 'read' }] },
              'PUT',
            ),
          );
          const opened = await ok(guest.b.call(`${base}/pages/${page}/collaboration`, {}), 201);
          const peer = securityPeer(
            host.ingress.url,
            String(opened.room),
            guest.b.cookie(),
            config.APP_ORIGIN,
          );
          peers.push(peer);
          await until(() => peer.provider.isSynced);
          await ok(
            admin.b.call(`${base}/members/${guestMember}`, { expectedRole: 'guest' }, 'DELETE'),
          );
          await until(() => peer.closed);
          peer.destroy();
          assert.equal((await guest.b.call(`${base}/pages/${page}`)).status, 404);
          const newRoot = String(
            (
              await ok(
                owner.b.call(base + '/pages', { title: 'Reinvitation scope', parentId: null }),
                201,
              )
            ).id,
          );
          const reinvited = summary(
            await ok(
              invite(admin, guest.email, 'guest', [{ pageId: newRoot, level: 'read' }]),
              201,
            ),
          );
          await ok(accept(guest, reinvited.id), 201);
          await ok(guest.b.call(`${base}/pages/${newRoot}`));
          assert.equal(
            (await guest.b.call(`${base}/pages/${page}`)).status,
            404,
            'reinvitation cannot resurrect the former grants',
          );
          assert.equal(
            (
              await db.pool.query('SELECT count(*) n FROM access_subjects WHERE member_id=$1', [
                guestMember,
              ])
            ).rows[0].n,
            '0',
          );
        },
      );
      await t.test(
        'I03: inviter loses authority and pending invitations are canceled; archived roots roll back acceptance',
        async () => {
          const next = await account();
          const sent = summary(
            await ok(invite(admin, next.email, 'guest', [{ pageId: page, level: 'read' }]), 201),
          );
          await ok(
            owner.b.call(
              `${base}/members/${adminMember}/role`,
              { expectedRole: 'admin', role: 'member' },
              'PUT',
            ),
          );
          assert.equal((await accept(next, sent.id)).status, 404);
          assert.equal(
            (await db.pool.query('SELECT status FROM workspace_invitations WHERE id=$1', [sent.id]))
              .rows[0].status,
            'canceled',
          );
          await ok(
            owner.b.call(
              `${base}/members/${adminMember}/role`,
              { expectedRole: 'member', role: 'admin' },
              'PUT',
            ),
          );
          const other = String(
            (
              await ok(
                owner.b.call(base + '/pages', { title: 'Will archive', parentId: null }),
                201,
              )
            ).id,
          );
          const s = summary(
            await ok(invite(owner, next.email, 'guest', [{ pageId: other, level: 'read' }]), 201),
          );
          await ok(owner.b.call(`${base}/pages/${other}/archive`, { expectedVersion: 1 }), 201);
          assert.equal((await accept(next, s.id)).status, 409);
          assert.equal(
            (await db.pool.query('SELECT status FROM workspace_invitations WHERE id=$1', [s.id]))
              .rows[0].status,
            'pending',
          );
        },
      );
      await t.test(
        'I05: newly accepted guest has no grace; enrollment alone exposes no content and verified factor restores access',
        async () => {
          const next = await account(),
            policy = await ok(owner.b.call(base + '/security'));
          await ok(
            owner.b.call(
              base + '/security',
              { expectedVersion: policy.version, requireStrongAuth: true, graceDays: 7 },
              'PUT',
            ),
          );
          const s = summary(
            await ok(invite(owner, next.email, 'guest', [{ pageId: page, level: 'read' }]), 201),
          );
          const arrival = arrivalSchema.parse(await ok(accept(next, s.id), 201));
          assert(!arrival.contentAllowed && arrival.requiresStrongAuth);
          const deadline = (
            await db.pool.query(
              'SELECT mfa_deadline<=clock_timestamp() blocked FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
              [workspace, next.id],
            )
          ).rows[0];
          assert(deadline.blocked);
          for (const path of ['/pages', '/search?q=Shared', `/pages/${page}`])
            assert.equal((await next.b.call(base + path)).status, 403);
          const opts = await ok(next.b.call('/passkey/generate-register-options'));
          await ok(
            next.b.call('/passkey/verify-registration', {
              response: next.key.register(String(opts.challenge)),
              name: 'Arrival key',
            }),
          );
          assert.equal((await next.b.call(base + '/arrival')).status, 403);
          await strong(next, false);
          const ready = arrivalSchema.parse(await ok(next.b.call(base + '/arrival')));
          assert(ready.contentAllowed);
          await ok(next.b.call(`${base}/pages/${page}`));
          const weak = await account();
          assert.equal((await weak.b.call(base + '/arrival')).status, 404);
        },
      );
      await resetQuotas();
      await t.test(
        'Q01: fifty real accounts behind one office IP can receive and accept fifty invitations',
        async () => {
          const target = String(
            (
              await ok(
                owner.b.call('/api/internal/workspaces', {
                  name: 'Office NAT',
                  slug: 'nat-' + randomUUID(),
                }),
                201,
              )
            ).id,
          );
          for (let i = 0; i < 50; i++) {
            const person = await account();
            const sent = summary(
              await ok(
                owner.b.call(`/api/internal/workspaces/${target}/invitations`, {
                  email: person.email,
                  role: 'member',
                }),
                201,
              ),
            );
            await ok(accept(person, sent.id), 201);
          }
          assert.equal(
            (
              await db.pool.query(
                'SELECT count(*) n FROM workspace_members WHERE workspace_id=$1',
                [target],
              )
            ).rows[0].n,
            '51',
          );
          console.info(
            'PASS NAT: 50 real password logins, creations and acceptances; same trusted source IP',
          );
        },
      );
      await resetQuotas();
      await t.test(
        'Q01/R12: all new routes require authentication; proxy forgery and UUID rotation cannot reset quotas',
        async () => {
          const anonymous = browser();
          const routes: [string, string, unknown?][] = [
            ['GET', base + '/invitations'],
            ['POST', base + '/invitations', {}],
            ['POST', base + `/invitations/${invitationId}/resend`, {}],
            ['POST', base + `/invitations/${invitationId}/cancel`, {}],
            ['GET', '/api/internal/invitations'],
            ['POST', '/api/internal/invitations/resolve', {}],
            ['POST', '/api/internal/invitations/accept', {}],
            ['POST', '/api/internal/invitations/reject', {}],
            ['GET', base + '/arrival'],
            ['GET', base + '/members'],
            ['PUT', base + `/members/${adminMember}/role`, {}],
            ['DELETE', base + `/members/${adminMember}`, {}],
            ['GET', base + '/security'],
            ['PUT', base + '/security', {}],
          ];
          for (const [method, path, body] of routes)
            assert.equal((await anonymous.call(path, body, method)).status, 401, path);
          const passwordOnly = browser();
          await ok(
            passwordOnly.call('/sign-in/email', { email: owner.email, password: owner.password }),
          );
          for (const [method, path, body] of routes)
            assert.equal(
              (await passwordOnly.call(path, body, method)).status,
              403,
              'restricted session: ' + path,
            );
          assert.equal(
            (await owner.b.call('/api/internal/invitations/accept')).status,
            404,
            'GET cannot accept an invitation',
          );
          app.set('trust proxy', false);
          for (const [method, path, body] of routes) {
            const canonical = path
              .replace(workspace, ':workspaceId')
              .replace(invitationId, ':id')
              .replace(adminMember, ':memberId');
            const family =
              path.endsWith('/resolve') || method === 'GET'
                ? 'read'
                : path.endsWith('/accept') || path.endsWith('/reject')
                  ? 'respond'
                  : path.endsWith('/resend') || path === base + '/invitations'
                    ? 'send'
                    : 'mutate';
            const max = { read: 600, respond: 150, send: 100, mutate: 60 }[family];
            const bucket = ipKey(
              config.BETTER_AUTH_SECRET,
              `access:${family}:${canonical}`,
              '127.0.0.1',
            );
            await db.pool.query(
              'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,$2,now(),now()) ON CONFLICT(key) DO UPDATE SET count=$2,started_at=now()',
              [bucket, max],
            );
            assert.equal(
              (await owner.b.call(path, body, method)).status,
              429,
              'mounted quota: ' + path,
            );
          }
          const path = '/api/internal/workspaces/:workspaceId/invitations';
          const key = ipKey(config.BETTER_AUTH_SECRET, 'access:read:' + path, '127.0.0.1');
          app.set('trust proxy', false);
          await db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,600,now(),now()) ON CONFLICT(key) DO UPDATE SET count=600,started_at=now()',
            [key],
          );
          const response = await owner.b.call(base + '/invitations/?limit=1', undefined, 'HEAD', {
            'x-forwarded-for': '198.51.100.77',
            'x-memoria-client-ip': '203.0.113.2',
          });
          assert.equal(response.status, 429);
          assert(response.headers.get('retry-after'));
          app.set('trust proxy', 'loopback');
          await resetQuotas();
          const accountKey = throttleKey(
            config.BETTER_AUTH_SECRET,
            'access:mutate',
            `${owner.id}:${workspace}`,
          );
          await db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,30,now(),now())',
            [accountKey],
          );
          assert.equal(
            (
              await owner.b.call(
                `${base}/members/${randomUUID()}/role`,
                { expectedRole: 'member', role: 'admin' },
                'PUT',
                { 'x-forwarded-for': '198.51.100.80' },
              )
            ).status,
            429,
          );
          await resetQuotas();
        },
      );
      await t.test(
        'Q02: pending/member/share capacities remain atomic under concurrent requests',
        async () => {
          const target = String(
            (
              await ok(
                owner.b.call('/api/internal/workspaces', {
                  name: 'Capacity',
                  slug: 'cap-' + randomUUID(),
                }),
                201,
              )
            ).id,
          );
          const a = await account(),
            b = await account(),
            c = await account();
          const make = (person: Account) =>
            owner.b.call(`/api/internal/workspaces/${target}/invitations`, {
              email: person.email,
              role: 'member',
            });
          process.env.WORKSPACE_MAX_PENDING_INVITATIONS = '2';
          process.env.WORKSPACE_MAX_MEMBERS = '2';
          try {
            const duplicates = await Promise.all([make(a), make(a)]);
            assert.deepEqual(duplicates.map((r) => r.status).sort(), [201, 409]);
            const first = summary(duplicates.find((r) => r.status === 201)!.data),
              second = summary(await ok(make(b), 201));
            assert.equal((await make(c)).status, 409);
            const accepted = await Promise.all([accept(a, first.id), accept(b, second.id)]);
            assert.deepEqual(accepted.map((r) => r.status).sort(), [201, 409]);
            assert.equal(
              (
                await db.pool.query(
                  'SELECT count(*) n FROM workspace_members WHERE workspace_id=$1',
                  [target],
                )
              ).rows[0].n,
              '2',
            );
          } finally {
            delete process.env.WORKSPACE_MAX_PENDING_INVITATIONS;
            delete process.env.WORKSPACE_MAX_MEMBERS;
          }
          const another = String(
            (
              await ok(
                owner.b.call(base + '/pages', { title: 'Capacity root', parentId: null }),
                201,
              )
            ).id,
          );
          process.env.GUEST_MAX_SHARED_ROOTS = '1';
          try {
            assert.equal(
              (
                await invite(owner, c.email, 'guest', [
                  { pageId: page, level: 'read' },
                  { pageId: another, level: 'edit' },
                ])
              ).status,
              409,
            );
          } finally {
            delete process.env.GUEST_MAX_SHARED_ROOTS;
          }
          const sent = summary(
            await ok(invite(owner, c.email, 'guest', [{ pageId: page, level: 'read' }]), 201),
          );
          process.env.WORKSPACE_MAX_SHARES = '1';
          try {
            assert.equal((await accept(c, sent.id)).status, 409);
            assert.equal(
              (
                await db.pool.query('SELECT status FROM workspace_invitations WHERE id=$1', [
                  sent.id,
                ])
              ).rows[0].status,
              'pending',
            );
          } finally {
            delete process.env.WORKSPACE_MAX_SHARES;
          }
          const tooMany = Array.from({ length: 21 }, () => ({
            pageId: randomUUID(),
            level: 'read',
          }));
          assert.equal((await invite(owner, c.email, 'guest', tooMany)).status, 400);
        },
      );
      await resetQuotas();
      await t.test(
        'Q02: sixteen concurrent creations finish without borrowing a second pooled connection',
        async () => {
          const results = await Promise.all(
            Array.from({ length: 16 }, () => invite(owner, `${randomUUID()}@example.test`)),
          );
          assert(
            results.every((r) => r.status === 201),
            'every authorized creation commits',
          );
          const ids = results.map((r) => summary(r.data).id);
          assert.equal(new Set(ids).size, 16);
          assert.equal(
            (
              await db.pool.query(
                'SELECT count(*) n FROM auth_mail_jobs WHERE invitation_id=ANY($1::uuid[])',
                [ids],
              )
            ).rows[0].n,
            '16',
          );
        },
      );
      await resetQuotas();
      await t.test(
        'I06/Q02: encrypted mail, destination budgets, bounded retries, cancellation and at-least-once delivery',
        async () => {
          // Isolated test schema only: process the jobs of this scenario, not earlier fixtures.
          await db.pool.query('DELETE FROM auth_mail_jobs');
          const email = `${randomUUID()}@example.test`;
          let sent = summary(await ok(invite(owner, email), 201));
          for (let n = 0; n < 3; n++)
            sent = summary(
              await ok(owner.b.call(`${base}/invitations/${sent.id}/resend`, {}), 201),
            );
          assert.equal(sent.deliveryStatus, 'limited');
          assert(sent.link);
          const delivered: { email: string; text: string }[] = [],
            reported: unknown[] = [];
          const options = {
            origin: config.APP_ORIGIN,
            secret: config.BETTER_AUTH_SECRET,
            send: async (email: string, _subject: string, text: string) => {
              delivered.push({ email, text });
            },
            report: (event: unknown) => {
              reported.push(event);
            },
          };
          while (await processAuthMail(connection.db, options)) {
            /* Drain this isolated test queue. */
          }
          assert.equal(
            delivered.length,
            0,
            'canceled/replaced jobs never send while already canceled',
          );
          const fresh = summary(await ok(invite(owner, `${randomUUID()}@example.test`), 201));
          const job = (
            await db.pool.query(
              'SELECT *,extract(epoch from expires_at-created_at) ttl FROM auth_mail_jobs WHERE invitation_id=$1',
              [fresh.id],
            )
          ).rows[0];
          assert(Number(job.ttl) <= 86400);
          assert(!job.payload.includes(fresh.email));
          assert(!job.payload.includes(fresh.id));
          const counters = (await db.pool.query('SELECT key,count FROM auth_buckets ORDER BY key'))
            .rows;
          await processAuthMail(connection.db, {
            ...options,
            send: async () => {
              throw new Error('SMTP fixture unavailable');
            },
          });
          assert.equal(
            (
              await db.pool.query('SELECT delivery_status FROM workspace_invitations WHERE id=$1', [
                fresh.id,
              ])
            ).rows[0].delivery_status,
            'retrying',
          );
          assert(!JSON.stringify(reported).includes(fresh.email!));
          await db.pool.query(
            'UPDATE auth_mail_jobs SET available_at=now() WHERE invitation_id=$1',
            [fresh.id],
          );
          // Simulate duplicate durable delivery: permissible, never a second membership.
          await db.pool.query(
            'INSERT INTO auth_mail_jobs(kind,invitation_id,payload,expires_at) SELECT kind,invitation_id,payload,expires_at FROM auth_mail_jobs WHERE invitation_id=$1',
            [fresh.id],
          );
          while (await processAuthMail(connection.db, options)) {
            /* Drain this isolated test queue. */
          }
          assert.equal(delivered.length, 2);
          assert(delivered.every((m) => m.text.includes(`/invitation#id=${fresh.id}`)));
          assert.deepEqual(
            (await db.pool.query('SELECT key,count FROM auth_buckets ORDER BY key')).rows,
            counters,
            'SMTP retry consumes no new budget',
          );
          assert.equal(
            (
              await db.pool.query(
                'SELECT status,delivery_status FROM workspace_invitations WHERE id=$1',
                [fresh.id],
              )
            ).rows[0].status,
            'pending',
          );
          const fail = summary(await ok(invite(owner, `${randomUUID()}@example.test`), 201));
          await db.pool.query('UPDATE auth_mail_jobs SET attempts=5 WHERE invitation_id=$1', [
            fail.id,
          ]);
          await processAuthMail(connection.db, {
            ...options,
            send: async () => {
              throw new Error('SMTP fixture unavailable');
            },
          });
          assert.equal(
            (
              await db.pool.query('SELECT delivery_status FROM workspace_invitations WHERE id=$1', [
                fail.id,
              ])
            ).rows[0].delivery_status,
            'failed',
          );
          assert.equal(
            (
              await db.pool.query('SELECT count(*) n FROM auth_mail_jobs WHERE invitation_id=$1', [
                fail.id,
              ])
            ).rows[0].n,
            '0',
          );
        },
      );
      await t.test(
        'I02: worker expiration/retention, immutable terminal time and independent runtime expiry',
        async () => {
          const next = summary(await ok(invite(owner, `${randomUUID()}@example.test`), 201));
          await db.pool.query(
            "UPDATE auth_mail_jobs SET expires_at=now()-interval '1 second' WHERE invitation_id=$1",
            [next.id],
          );
          await purgeInvitations(connection.db);
          assert.equal(
            (
              await db.pool.query('SELECT delivery_status FROM workspace_invitations WHERE id=$1', [
                next.id,
              ])
            ).rows[0].delivery_status,
            'expired',
          );
          await db.pool.query(
            "UPDATE workspace_invitations SET expires_at=now()-interval '1 second' WHERE id=$1",
            [next.id],
          );
          await purgeInvitations(connection.db);
          const closed = (
            await db.pool.query('SELECT status,closed_at FROM workspace_invitations WHERE id=$1', [
              next.id,
            ])
          ).rows[0];
          assert.equal(closed.status, 'expired');
          assert(closed.closed_at);
          await db.pool.query(
            "UPDATE workspace_invitations SET closed_at=now()+interval '1 year' WHERE id=$1",
            [next.id],
          );
          assert.deepEqual(
            (
              await db.pool.query('SELECT closed_at FROM workspace_invitations WHERE id=$1', [
                next.id,
              ])
            ).rows[0].closed_at,
            closed.closed_at,
          );
          const old = randomUUID();
          await db.pool.query(
            "INSERT INTO workspace_invitations(id,workspace_id,inviter_id,email,role,status,expires_at,closed_at) VALUES($1,$2,$3,'purge@example.test','member','canceled',now()-interval '32 days',now()-interval '31 days')",
            [old, workspace, owner.id],
          );
          await purgeInvitations(connection.db);
          assert.equal(
            (await db.pool.query('SELECT count(*) n FROM workspace_invitations WHERE id=$1', [old]))
              .rows[0].n,
            '0',
          );
        },
      );
    } finally {
      for (const peer of peers) peer.destroy();
      await host.close();
      await app.close();
      await connection.pool.end();
      await db.close();
    }
  },
);
