import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import * as Y from 'yjs';
import { createAuth, ipKey } from '@memoria/auth';
import { internalSignature } from '@memoria/auth/collaboration';
import { createDatabase, resolvePageAccess } from '@memoria/db';
import {
  pageSchema,
  pageDocumentSchema,
  collaborationAccessSchema,
  pageTreeSchema,
  searchResultsSchema,
  canonicalJson,
} from '@memoria/contracts';
import { AppModule, configureApplication } from './app.ts';
import { AuthService } from './modules/auth/auth.service.ts';
import { readConfig } from './config.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { securityPeer } from '../../collab/src/testing/security-peer.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { decodeDocument } from '../../collab/src/codec.ts';

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await delay(20);
  }
}
async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
function paragraph(doc: Y.Doc) {
  return [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
    (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'paragraph',
  )!;
}

await test(
  '5a: real Nest, Better Auth sessions, PostgreSQL grants, HMAC and hostile WebSockets',
  { timeout: 180000 },
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
    const host = await collaborationServer(
      readCollabConfig({ ...process.env, COLLAB_PORT: '0', COLLAB_INTERNAL_PORT: '0' }),
      db.pool,
      sessionVerifier(app.get(AuthService).auth),
    );
    process.env.COLLAB_INTERNAL_URL = host.internal.url;
    const peers: ReturnType<typeof securityPeer>[] = [];
    const accounts: {
      user: string;
      session: string;
      cookie: string;
      subject: string;
      member: string;
    }[] = [];
    const base = `/api/internal/workspaces/${db.workspace}`;
    const request = (
      path: string,
      index = 0,
      method = 'GET',
      body?: unknown,
      headers: Record<string, string> = {},
    ) =>
      fetch(origin + path, {
        method,
        headers: {
          origin: config.APP_ORIGIN,
          'content-type': 'application/json',
          'x-forwarded-for': '192.0.2.51',
          cookie: accounts[index]?.cookie ?? '',
          ...headers,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    const grant = async (index: number, page: string, level: 'read' | 'edit') => {
      const id = randomUUID();
      await db.pool.query(
        'INSERT INTO access_grants(id,workspace_id,subject_id,resource_id,level) VALUES($1,$2,$3,$4,$5)',
        [id, db.workspace, accounts[index]!.subject, page, level],
      );
      return id;
    };
    const fixtureAuth = createAuth(connection.db, {
      origin: config.APP_ORIGIN,
      secret: config.BETTER_AUTH_SECRET,
      sendVerificationEmail: async () => {},
    });
    try {
      // Identity fixtures use real password hashing/cookies; email verification is setup SQL.
      for (const role of ['owner', 'admin', 'member', 'guest', 'guest', 'guest']) {
        const email = `${randomUUID()}@example.test`,
          password = randomBytes(24).toString('hex');
        const call = (path: string, body: object) =>
          fixtureAuth.handler(
            new Request(`${config.APP_ORIGIN}/api/auth/${path}`, {
              method: 'POST',
              headers: { origin: config.APP_ORIGIN, 'content-type': 'application/json' },
              body: JSON.stringify(body),
            }),
          );
        await json(await call('sign-up/email', { name: `Fixture ${role}`, email, password }));
        await db.pool.query('UPDATE auth_users SET email_verified=true WHERE email=$1', [email]);
        const login = await call('sign-in/email', { email, password });
        await json(login);
        const cookie = login.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; ');
        const session = await fixtureAuth.api.getSession({ headers: new Headers({ cookie }) });
        assert(session);
        const member = randomUUID(),
          subject = randomUUID();
        await db.pool.query(
          'INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)',
          [member, db.workspace, session.user.id, role],
        );
        await db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
          db.workspace,
          session.user.id,
        ]);
        await db.pool.query(
          "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3)",
          [subject, db.workspace, member],
        );
        accounts.push({
          user: session.user.id,
          session: session.session.id,
          cookie,
          member,
          subject,
        });
      }
      const create = async (title: string, parentId: string | null = null, index = 0) =>
        pageSchema.parse(
          await json(await request(`${base}/pages`, index, 'POST', { title, parentId }), 201),
        );
      const hidden = await create('HIDDEN_PARENT_CANARY'),
        root = await create('Shared', hidden.id),
        child = await create('Shared child', root.id),
        other = await create('HIDDEN_SIBLING_CANARY');
      const opened = collaborationAccessSchema.parse(
        await json(await request(`${base}/pages/${child.id}/collaboration`, 0, 'POST', {}), 201),
      );
      const command = (index: number, operations: unknown[], expectedRevision?: number) =>
        request(`${base}/pages/${child.id}/content`, index, 'PUT', {
          generation: opened.generation,
          expectedRevision:
            expectedRevision ??
            Number(host.rooms.get(opened.room)?.revision ?? opened.contentRevision),
          receipt: randomUUID(),
          operations,
        });
      const add = (text: string) => ({
        op: 'insert',
        id: randomUUID(),
        parentId: null,
        afterId: null,
        type: 'core.paragraph',
        schemaVersion: 1,
        content: { spans: [{ type: 'text', text, styles: {} }] },
      });
      const deleted = add('DELETED_HISTORY_CANARY');
      await json(await command(0, [deleted], opened.contentRevision));
      await json(await command(0, [{ op: 'archive', id: deleted.id }]));
      await until(async () => {
        const r = (
          await db.pool.query(
            'SELECT content_revision=projection_revision AS ready FROM collaboration_documents WHERE page_id=$1',
            [child.id],
          )
        ).rows[0];
        return r.ready;
      }, 'initial projection');
      // Deleted history predates the grants and the reader's first connection.
      const readGrant = await grant(3, root.id, 'read');
      await grant(5, root.id, 'read');
      await grant(4, root.id, 'read');
      await grant(4, child.id, 'edit');
      const peer = async (index: number) => {
        const p = securityPeer(
          host.ingress.url,
          opened.room,
          accounts[index]!.cookie,
          config.APP_ORIGIN,
        );
        peers.push(p);
        await until(() => p.provider.isSynced || p.failed || p.closed, 'peer sync');
        assert(!p.failed && !p.closed, p.reason);
        return p;
      };
      const snapshot = async () =>
        (
          await db.pool.query(
            `SELECT content_revision,projection_revision,
      (SELECT count(*) FROM collaboration_updates WHERE page_id=$1) AS updates,
      (SELECT count(*) FROM audit_logs WHERE resource_id=$1) AS audit,
      (SELECT count(*) FROM outbox_events WHERE aggregate_id=$1) AS outbox
      FROM collaboration_documents WHERE page_id=$1`,
            [child.id],
          )
        ).rows[0];

      await t.test(
        'A01/A02: inherited maximum, hidden ancestors and SQL/API decisions agree',
        async () => {
          for (const index of [0, 1, 2, 3, 4]) {
            const list = pageTreeSchema.parse(await json(await request(`${base}/pages`, index)));
            const expected =
              index < 3 ? [db.page, hidden.id, root.id, child.id, other.id] : [root.id, child.id];
            assert.deepEqual(list.pages.map((p) => p.id).sort(), expected.sort());
            for (const page of [hidden, root, child, other]) {
              const resolved = await resolvePageAccess(db.pool, [
                { key: page.id, ...accounts[index]!, workspace: db.workspace, page: page.id },
              ]);
              const response = await request(`${base}/pages/${page.id}`, index);
              assert.equal(response.status, resolved.has(page.id) ? 200 : 404);
              if (index >= 3 && resolved.has(page.id))
                assert.equal(
                  resolved.get(page.id)?.level,
                  index === 4 && page.id === child.id ? 'edit' : 'read',
                );
            }
            if (index >= 3) {
              assert.equal(list.trash.length, 0);
              const serialized = JSON.stringify(list);
              assert(
                !serialized.includes(hidden.id) &&
                  !serialized.includes(hidden.title) &&
                  !serialized.includes(other.title),
              );
              assert.equal(list.pages.find((p) => p.id === root.id)?.parentId, null);
            }
          }
          await assert.rejects(grant(4, child.id, 'read'), { code: '23505' });
          assert.equal((await request(`${base}/pages`, 99)).status, 401);
          assert.equal((await request(`${base}/pages/${randomUUID()}`, 3)).status, 404);
          const wrong = await resolvePageAccess(db.pool, [
            {
              key: 'forged',
              ...accounts[3]!,
              user: accounts[0]!.user,
              workspace: db.workspace,
              page: child.id,
            },
          ]);
          assert.equal(wrong.size, 0);
          const foreign = randomUUID();
          await db.pool.query(
            "INSERT INTO workspaces(id,name,slug) VALUES($1::uuid,'Other',$1::text)",
            [foreign],
          );
          assert.equal(
            (await request(`/api/internal/workspaces/${foreign}/pages/${child.id}`, 3)).status,
            404,
          );
          await assert.rejects(
            db.pool.query(
              "INSERT INTO access_grants(workspace_id,subject_id,resource_id,level) VALUES($1,$2,$3,'edit')",
              [foreign, accounts[3]!.subject, child.id],
            ),
          );
        },
      );
      await t.test(
        'R12: every page route rejects anonymous calls; alternate read/write routes keep guest boundaries',
        async () => {
          const versioned = { expectedVersion: 1 };
          const routes: [string, string, unknown?][] = [
            ['GET', '/pages'],
            ['GET', `/pages/${child.id}`],
            ['GET', `/pages/${child.id}/version`],
            ['GET', '/search?q=Shared'],
            ['POST', '/pages', { title: 'Forbidden', parentId: child.id }],
            ['PUT', `/pages/${child.id}`, { ...versioned, title: 'Forbidden', operations: [] }],
            ['POST', `/pages/${child.id}/collaboration`, {}],
            [
              'PUT',
              `/pages/${child.id}/content`,
              {
                generation: opened.generation,
                expectedRevision: 2,
                receipt: randomUUID(),
                operations: [add('Forbidden')],
              },
            ],
            ['POST', `/pages/${child.id}/rename`, { ...versioned, title: 'Forbidden' }],
            ['POST', `/pages/${child.id}/move`, { ...versioned, parentId: null, afterId: null }],
            ['POST', `/pages/${child.id}/archive`, versioned],
            ['POST', `/pages/${child.id}/restore`, versioned],
          ];
          for (const [method, path, body] of routes) {
            assert.equal(
              (await request(base + path, 99, method, body)).status,
              401,
              `${method} ${path}`,
            );
          }
          await json(await request(`${base}/pages/${child.id}/version`, 3));
          await json(await request(`${base}/pages/${child.id}/collaboration`, 3, 'POST', {}), 201);
          for (const [method, path, body] of routes.filter(([, path]) => path.includes(child.id))) {
            const response = await request(
              base + path.replace(child.id, hidden.id),
              3,
              method,
              body,
            );
            assert.equal(response.status, /\/(move|archive|restore)$/.test(path) ? 403 : 404, path);
          }
          assert.equal(
            (
              await request(`${base}/pages/${child.id}`, 3, 'PUT', {
                ...versioned,
                title: 'Forbidden',
                operations: [],
              })
            ).status,
            403,
          );
          assert.equal(
            (
              await request(`${base}/pages`, 4, 'POST', {
                title: 'Forbidden',
                parentId: hidden.id,
              })
            ).status,
            404,
          );
          assert.equal(
            (await db.pool.query('SELECT title,version FROM pages WHERE id=$1', [child.id])).rows[0]
              .title,
            'Shared child',
          );
        },
      );
      await t.test(
        'A02: inaccessible matches cannot fill the first hundred search results',
        async () => {
          await db.pool.query(
            "INSERT INTO pages(workspace_id,title,position,updated_at) SELECT $1,'Needle private', 'q'||lpad(n::text,5,'0'),now()-interval '1 day' FROM generate_series(1,105) n",
            [db.workspace],
          );
          await db.pool.query(
            "INSERT INTO search_documents(workspace_id,page_id,plain_text,page_version) SELECT workspace_id,id,'Needle HIDDEN_SEARCH_CANARY',version FROM pages WHERE workspace_id=$1 AND title='Needle private'",
            [db.workspace],
          );
          await json(await command(0, [add('Needle shared')]));
          const matches = searchResultsSchema.parse(
            await json(await request(`${base}/search?q=Needle`, 3)),
          );
          assert.equal(matches.length, 1);
          assert.equal(matches[0]?.id, child.id);
          assert(!JSON.stringify(matches).includes('HIDDEN_SEARCH_CANARY'));
        },
      );
      await t.test(
        'A01/A04: read cannot mutate; edit can rename/create children but cannot manage the tree',
        async () => {
          assert.equal(
            (
              await request(`${base}/pages/${child.id}/rename`, 3, 'POST', {
                expectedVersion: 1,
                title: 'Forbidden',
              })
            ).status,
            403,
          );
          assert.equal(
            (await request(`${base}/pages`, 3, 'POST', { parentId: child.id, title: 'Forbidden' }))
              .status,
            403,
          );
          assert.equal(
            (await request(`${base}/pages`, 4, 'POST', { parentId: null, title: 'Forbidden' }))
              .status,
            403,
          );
          await json(
            await request(`${base}/pages/${child.id}/rename`, 4, 'POST', {
              expectedVersion: 1,
              title: 'Guest title',
            }),
            201,
          );
          assert.equal(
            (
              await request(`${base}/pages/${child.id}/rename`, 4, 'POST', {
                expectedVersion: 1,
                title: 'Stale',
              })
            ).status,
            409,
          );
          const sub = await create('Guest subpage', child.id, 4);
          await json(await request(`${base}/pages/${sub.id}`, 3));
          for (const action of ['move', 'archive', 'restore'])
            assert.equal(
              (
                await request(`${base}/pages/${child.id}/${action}`, 4, 'POST', {
                  expectedVersion: 2,
                  ...(action === 'move' ? { parentId: null, afterId: null } : {}),
                })
              ).status,
              403,
            );
          assert.equal(
            (
              await request(`${base}/pages/${child.id}/move`, 0, 'POST', {
                expectedVersion: 2,
                parentId: null,
                afterId: null,
              })
            ).status,
            409,
          );
          for (const index of [1, 3, 4]) {
            assert.equal(
              (
                await request(`${base}/security`, index, 'PUT', {
                  expectedVersion: 1,
                  requireStrongAuth: false,
                  graceDays: 7,
                })
              ).status === 200,
              false,
            );
            assert.equal(
              (
                await request('/api/auth/organization/update-member-role', index, 'POST', {
                  organizationId: db.workspace,
                  memberId: accounts[index]!.member,
                  role: 'owner',
                })
              ).status,
              404,
            );
          }
        },
      );
      await t.test(
        'C01/L01: read receives live Yjs but cannot send update, sync2, delete-set or writer commands',
        async () => {
          const card = randomUUID();
          await json(
            await command(4, [
              {
                op: 'insert',
                id: card,
                parentId: null,
                afterId: null,
                type: 'gamedev.character-card',
                schemaVersion: 2,
                content: {
                  characterId: randomUUID(),
                  displayName: 'Guest card',
                  archetype: 'npc',
                  biography: '',
                  health: 100,
                  attack: 10,
                  tags: [],
                },
              },
            ]),
          );
          const projected = pageDocumentSchema.parse(
            await json(await request(`${base}/pages/${child.id}`, 3)),
          );
          assert(projected.blocks.some((b) => b.id === card));
          const observer = await peer(3),
            editor = await peer(4);
          assert(
            decodeDocument(observer.doc).some((b) => b.id === card),
            'reader receives character card',
          );
          const node = paragraph(editor.doc),
            text = new Y.XmlText();
          text.insert(0, 'Live writer');
          node.insert(0, [text]);
          await until(
            () => paragraph(observer.doc).toString().includes('Live writer'),
            'read receives broadcast',
          );
          const state = Buffer.from(Y.encodeStateAsUpdate(observer.doc));
          for (const canary of [
            'HIDDEN_PARENT_CANARY',
            'HIDDEN_SIBLING_CANARY',
            'DELETED_HISTORY_CANARY',
          ])
            assert(!state.includes(Buffer.from(canary)), canary);
          await until(async () => {
            const s = await snapshot();
            return s.content_revision === s.projection_revision;
          }, 'projection before rejection');
          for (const [attempt, type] of ([2, 1, 2] as const).entries()) {
            const attacker = await peer(5),
              candidate = new Y.Doc();
            Y.applyUpdate(candidate, Y.encodeStateAsUpdate(attacker.doc));
            const vector = Y.encodeStateVector(candidate),
              p = paragraph(candidate);
            if (type === 1 || attempt === 0) {
              const n = new Y.XmlText();
              n.insert(0, 'Forbidden sync');
              p.insert(0, [n]);
            } else if (p.length) p.delete(0, p.length);
            else {
              const n = new Y.XmlText();
              n.insert(0, 'Forbidden update');
              p.insert(0, [n]);
            }
            const before = await snapshot();
            attacker.sendYjs(Y.encodeStateAsUpdate(candidate, vector), type);
            await until(() => attacker.closed, 'hostile read closed');
            assert.deepEqual(await snapshot(), before);
            attacker.destroy();
            candidate.destroy();
          }
          const before = await snapshot();
          assert.equal((await command(3, [add('Forbidden HTTP')])).status, 403);
          // Bypass Nest's preflight: a valid internal signature grants no page permission.
          const internalUrl = new URL(host.internal.url);
          const body = canonicalJson({
            action: 'write',
            user: accounts[3]!.user,
            session: accounts[3]!.session,
            workspace: db.workspace,
            page: child.id,
            generation: opened.generation,
            expectedRevision: Number(host.rooms.get(opened.room)!.revision),
            receipt: randomUUID(),
            operations: [add('Forbidden HMAC')],
          });
          const rejected = await fetch(internalUrl, {
            method: 'POST',
            headers: {
              'content-type': 'application/json',
              ...internalSignature(config.COLLAB_INTERNAL_SECRET, internalUrl.pathname, body),
            },
            body,
          });
          assert.equal(rejected.status, 403);
          assert.equal(((await rejected.json()) as { code: string }).code, 'READ_ONLY');
          assert.deepEqual(await snapshot(), before);
          assert(!editor.closed && !observer.closed, 'innocent sockets preserved');
        },
      );
      await t.test(
        'A03: relational rename also rechecks rights after waiting for a committed downgrade',
        async () => {
          const blocker = await db.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              "UPDATE access_grants SET level='read' WHERE subject_id=$1 AND resource_id=$2",
              [accounts[4]!.subject, child.id],
            );
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const pending = request(`${base}/pages/${child.id}/rename`, 4, 'POST', {
              expectedVersion: 2,
              title: 'Must not rename',
            });
            await until(
              async () =>
                Boolean(
                  (
                    await db.pool.query(
                      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
                      [pid],
                    )
                  ).rows[0].waiting,
                ),
              'relational lock wait',
            );
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 403);
            assert.equal(
              (await db.pool.query('SELECT title FROM pages WHERE id=$1', [child.id])).rows[0]
                .title,
              'Guest title',
            );
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          await db.pool.query(
            "UPDATE access_grants SET level='edit' WHERE subject_id=$1 AND resource_id=$2",
            [accounts[4]!.subject, child.id],
          );
        },
      );
      await t.test(
        'A03/C02: committed downgrade beats a real HTTP writer waiting on access locks',
        async () => {
          const before = await snapshot(),
            blocker = await db.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              "UPDATE access_grants SET level='read' WHERE subject_id=$1 AND resource_id=$2",
              [accounts[4]!.subject, child.id],
            );
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            const pending = command(4, [add('Must not commit')], Number(before.content_revision));
            await until(
              async () =>
                Boolean(
                  (
                    await db.pool.query(
                      'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS waiting',
                      [pid],
                    )
                  ).rows[0].waiting,
                ),
              'actual blocked writer',
            );
            await blocker.query('COMMIT');
            assert.equal((await pending).status, 403);
            assert.deepEqual(await snapshot(), before);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
          }
          await db.pool.query(
            "UPDATE access_grants SET level='edit' WHERE subject_id=$1 AND resource_id=$2",
            [accounts[4]!.subject, child.id],
          );
        },
      );
      await t.test(
        'A03/C02: a real WebSocket update waits for the page lock then sees the committed downgrade',
        async () => {
          const editor = await peer(4),
            candidate = new Y.Doc();
          Y.applyUpdate(candidate, Y.encodeStateAsUpdate(editor.doc));
          const vector = Y.encodeStateVector(candidate),
            text = new Y.XmlText();
          text.insert(0, 'Rejected queued socket');
          paragraph(candidate).insert(0, [text]);
          const before = await snapshot(),
            blocker = await db.pool.connect();
          try {
            await blocker.query('BEGIN');
            await blocker.query(
              "UPDATE access_grants SET level='read' WHERE subject_id=$1 AND resource_id=$2",
              [accounts[4]!.subject, child.id],
            );
            const pid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
            editor.sendYjs(Y.encodeStateAsUpdate(candidate, vector));
            await until(
              async () =>
                Boolean(
                  (
                    await db.pool.query(
                      "SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid)) AND query LIKE '%FROM pages%') AS waiting",
                      [pid],
                    )
                  ).rows[0].waiting,
                ),
              'journal page row lock',
            );
            await blocker.query('COMMIT');
            await until(() => editor.closed, 'queued socket revoked');
            assert.deepEqual(await snapshot(), before);
          } finally {
            await blocker.query('ROLLBACK');
            blocker.release();
            editor.destroy();
            candidate.destroy();
          }
          await db.pool.query(
            "UPDATE access_grants SET level='edit' WHERE subject_id=$1 AND resource_id=$2",
            [accounts[4]!.subject, child.id],
          );
        },
      );
      await t.test(
        'C02: missed notification still disconnects descendants within five seconds',
        async () => {
          const reader = await peer(3),
            started = Date.now();
          await db.pool.query('ALTER TABLE access_grants DISABLE TRIGGER content_notify_grant');
          try {
            await db.pool.query('DELETE FROM access_grants WHERE id=$1', [readGrant]);
            await until(() => reader.closed, 'fallback revocation', 5000);
            assert(Date.now() - started < 5000);
          } finally {
            await db.pool.query('ALTER TABLE access_grants ENABLE TRIGGER content_notify_grant');
          }
          assert.equal((await request(`${base}/pages/${child.id}`, 3)).status, 404);
          const denied = securityPeer(
            host.ingress.url,
            opened.room,
            accounts[3]!.cookie,
            config.APP_ORIGIN,
          );
          peers.push(denied);
          await until(() => denied.failed || denied.closed, 'direct socket denied');
          await grant(3, root.id, 'read');
        },
      );
      await t.test(
        'A01/A02: strongest ancestor wins; archive hides direct grants; move recalculates inheritance',
        async () => {
          const g = await grant(3, hidden.id, 'edit');
          assert.equal(
            (
              await resolvePageAccess(db.pool, [
                { key: 'x', ...accounts[3]!, workspace: db.workspace, page: child.id },
              ])
            ).get('x')?.level,
            'edit',
          );
          await db.pool.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [hidden.id]);
          assert.equal((await request(`${base}/pages/${child.id}`, 4)).status, 404);
          await db.pool.query('UPDATE pages SET deleted_at=NULL WHERE id=$1', [hidden.id]);
          await db.pool.query('DELETE FROM access_grants WHERE id=$1', [g]);
          await db.pool.query('UPDATE pages SET parent_id=$2 WHERE id=$1', [child.id, other.id]);
          assert.equal((await request(`${base}/pages/${child.id}`, 3)).status, 404);
          assert.equal(
            (await request(`${base}/pages/${child.id}`, 4)).status,
            200,
            'direct grant follows page',
          );
          await db.pool.query('UPDATE pages SET parent_id=$2 WHERE id=$1', [child.id, root.id]);
        },
      );
      await t.test(
        'I05: policy, recovery and expired sessions cannot bypass page or socket rights',
        async () => {
          await db.pool.query(
            'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days) VALUES($1,true,0)',
            [db.workspace],
          );
          assert.equal((await request(`${base}/pages/${child.id}`, 3)).status, 403);
          const denied = securityPeer(
            host.ingress.url,
            opened.room,
            accounts[3]!.cookie,
            config.APP_ORIGIN,
          );
          peers.push(denied);
          await until(() => denied.closed || denied.failed, 'weak socket denied');
          await db.pool.query(
            'UPDATE workspace_policies SET require_strong_auth=false WHERE workspace_id=$1',
            [db.workspace],
          );
          await db.pool.query(
            'INSERT INTO account_security(user_id,recovery_required) VALUES($1,true)',
            [accounts[3]!.user],
          );
          assert.equal((await request(`${base}/pages/${child.id}`, 3)).status, 403);
          await db.pool.query(
            'UPDATE account_security SET recovery_required=false WHERE user_id=$1',
            [accounts[3]!.user],
          );
          await db.pool.query(
            "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
            [accounts[5]!.session],
          );
          assert.equal((await request(`${base}/pages/${child.id}`, 5)).status, 401);
        },
      );
      await t.test(
        'A03: promotion/removal cannot resurrect dormant grants; anonymous audit records cleanup',
        async () => {
          await db.pool.query("UPDATE workspace_members SET role='member' WHERE id=$1", [
            accounts[3]!.member,
          ]);
          assert.equal(
            Number(
              (
                await db.pool.query('SELECT count(*) FROM access_grants WHERE subject_id=$1', [
                  accounts[3]!.subject,
                ])
              ).rows[0].count,
            ),
            0,
          );
          assert.equal(
            Number(
              (
                await db.pool.query(
                  "SELECT count(*) FROM audit_logs WHERE resource_id=$1 AND action='member.guest_grants.cleared'",
                  [accounts[3]!.member],
                )
              ).rows[0].count,
            ),
            1,
          );
          await db.pool.query("UPDATE workspace_members SET role='guest' WHERE id=$1", [
            accounts[3]!.member,
          ]);
          assert.equal((await request(`${base}/pages/${child.id}`, 3)).status, 404);
          await grant(3, root.id, 'read');
          await db.pool.query('DELETE FROM workspace_members WHERE id=$1', [accounts[3]!.member]);
          assert.equal((await request(`${base}/pages`, 3)).status, 404);
          assert.equal(
            Number(
              (
                await db.pool.query('SELECT count(*) FROM access_grants WHERE subject_id=$1', [
                  accounts[3]!.subject,
                ])
              ).rows[0].count,
            ),
            0,
          );
        },
      );
      await t.test(
        'Q01: matched route/IP and shared account budgets resist header and UUID rotation',
        async () => {
          const template = '/api/internal/workspaces/:workspaceId/pages/:pageId';
          const key = ipKey(config.BETTER_AUTH_SECRET, `content:read:${template}`, '192.0.2.51');
          await db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,3600,now(),now()) ON CONFLICT(key) DO UPDATE SET count=3600,started_at=now()',
            [key],
          );
          for (const page of [child.id, randomUUID()]) {
            const r = await request(`${base}/pages/${page}`, 0, 'GET', undefined, {
              'x-memoria-client-ip': '198.51.100.2',
            });
            assert.equal(r.status, 429);
            assert(r.headers.has('retry-after'));
          }
          app.set('trust proxy', false);
          const directKey = ipKey(
            config.BETTER_AUTH_SECRET,
            `content:read:${template}`,
            '127.0.0.1',
          );
          await db.pool.query(
            'INSERT INTO auth_buckets(key,count,started_at,touched_at) VALUES($1,3600,now(),now()) ON CONFLICT(key) DO UPDATE SET count=3600,started_at=now()',
            [directKey],
          );
          assert.equal(
            (
              await request(`${base}/pages/${child.id}/?q=alternate`, 0, 'HEAD', undefined, {
                'x-forwarded-for': '198.51.100.92',
                forwarded: 'for=198.51.100.93',
                'x-memoria-client-ip': '198.51.100.94',
              })
            ).status,
            429,
          );
          app.set('trust proxy', 'loopback');
          await db.pool.query('DELETE FROM auth_buckets');
          for (let i = 0; i < 120; i++)
            assert.equal(
              (
                await request(`${base}/pages/${randomUUID()}`, 4, 'GET', undefined, {
                  'x-forwarded-for': `198.51.100.${i + 1}`,
                })
              ).status,
              404,
            );
          assert.equal(
            (await request(`${base}/pages/${child.id}/version`, 4)).status,
            429,
            'same account read family across routes',
          );
          assert.equal(
            (await request(`${base}/pages/${child.id}/version`, 2)).status,
            200,
            'other account unaffected',
          );
        },
      );
      assert(
        decodeDocument(host.rooms.get(opened.room)!.doc).every(
          (b) => !JSON.stringify(b).includes('Forbidden'),
        ),
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
