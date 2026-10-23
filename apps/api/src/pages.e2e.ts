import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createDatabase } from '@memoria/db';
import {
  pageDocumentSchema,
  pageSchema,
  pageTreeSchema,
  searchResultsSchema,
} from '@memoria/contracts';
import { AppModule, configureApplication } from './app.ts';
import { readConfig } from './config.ts';

const config = readConfig();
assert.notEqual(config.NODE_ENV, 'production');
assert.equal(config.APP_ORIGIN, 'https://localhost');
const { pool } = createDatabase(config.DATABASE_URL);
const run = randomBytes(6).toString('hex');
const users: { id: string; email: string; cookie: string; ip: string }[] = [];
const workspaceIds: string[] = [];
const app = await NestFactory.create<NestExpressApplication>(AppModule, {
  bodyParser: false,
  logger: false,
});
configureApplication(app);
app.set('trust proxy', 'loopback');
await app.listen(0, '127.0.0.1');
const origin = await app.getUrl();
async function request(path: string, index = 0, method = 'GET', body?: unknown) {
  const account = users[index];
  return globalThis.fetch(`${origin}${path}`, {
    method,
    headers: {
      Origin: config.APP_ORIGIN,
      'Content-Type': 'application/json',
      'x-forwarded-for': account?.ip ?? `2001:db8:aaaa:${run.slice(0, 4)}::1`,
      Cookie: account?.cookie ?? '',
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
}
async function json(response: Response, status = 200): Promise<unknown> {
  const body: unknown = await response.json();
  assert.equal(response.status, status, JSON.stringify(body));
  return body;
}
try {
  await test(
    'Session 2: real Nest, authentication and transactional PostgreSQL pages',
    { timeout: 120000 },
    async (t) => {
      for (let index = 0; index < 4; index++) {
        const email = `s2-${run}-${index}@example.test`;
        const password = randomBytes(20).toString('hex');
        users.push({
          id: '',
          email,
          cookie: '',
          ip: `2001:0db8:${run.slice(0, 4)}:${String(index + 1).padStart(4, '0')}:0000:0000:0000:0000`,
        });
        await json(
          await request('/api/auth/sign-up/email', index, 'POST', {
            name: 'Session Two Fixture',
            email,
            password,
          }),
        );
        const verified = await pool.query<{ id: string }>(
          'update auth_users set email_verified=true where email=$1 returning id',
          [email],
        );
        users[index]!.id = verified.rows[0]!.id;
        const login = await request('/api/auth/sign-in/email', index, 'POST', { email, password });
        await json(login);
        users[index]!.cookie = login.headers
          .getSetCookie()
          .map((value) => value.split(';')[0])
          .join('; ');
      }
      const workspace = (await json(
        await request('/api/internal/workspaces', 0, 'POST', {
          name: 'Pages E2E',
          slug: `s2-${run}`,
        }),
        201,
      )) as { id: string };
      workspaceIds.push(workspace.id);
      for (const index of [1, 2]) {
        await pool.query(
          'insert into workspace_members (id,workspace_id,user_id,role,created_at,updated_at) values ($1,$2,$3,$4,now(),now())',
          [randomUUID(), workspace.id, users[index]!.id, index === 1 ? 'member' : 'guest'],
        );
        await pool.query("insert into actors (workspace_id,kind,user_id) values ($1,'user',$2)", [
          workspace.id,
          users[index]!.id,
        ]);
      }
      const base = `/api/internal/workspaces/${workspace.id}`;
      const create = async (title: string, parentId: string | null = null) =>
        pageSchema.parse(
          await json(await request(`${base}/pages`, 0, 'POST', { title, parentId }), 201),
        );
      const get = async (id: string, index = 0) =>
        pageDocumentSchema.parse(await json(await request(`${base}/pages/${id}`, index)));
      const root = await create('Atelier');
      const child = await create('Quêtes secrètes', root.id);
      const other = await create('Autre page');
      const p = randomUUID(),
        nested = randomUUID(),
        task = randomUUID();
      const content = (text: string) => ({
        spans: [{ type: 'text', text, styles: { bold: true } }],
      });
      await t.test(
        'owner/member share content; guests, outsiders and anonymous requests are denied',
        async () => {
          assert.equal((await request(`${base}/pages`, 1)).status, 200);
          for (const index of [2, 3, 10])
            for (const path of ['pages', `pages/${root.id}`, 'search?q=Atelier'])
              assert.equal(
                (await request(`${base}/${path}`, index)).status,
                index === 10 ? 401 : 404,
              );
          assert.equal(
            (await request(`${base}/pages`, 2, 'POST', { title: 'Denied', parentId: null })).status,
            404,
          );
        },
      );
      await t.test('nested inserts commit once with search, audit and outbox', async () => {
        await json(
          await request(`${base}/pages/${child.id}`, 1, 'PUT', {
            expectedVersion: 1,
            title: child.title,
            operations: [
              {
                op: 'insert',
                id: p,
                parentId: null,
                afterId: null,
                type: 'core.paragraph',
                schemaVersion: 1,
                content: content('Dragon argenté'),
              },
              {
                op: 'insert',
                id: nested,
                parentId: p,
                afterId: null,
                type: 'core.bullet-list-item',
                schemaVersion: 1,
                content: content('Trouver la clé'),
              },
              {
                op: 'insert',
                id: task,
                parentId: nested,
                afterId: null,
                type: 'core.todo',
                schemaVersion: 1,
                content: { ...content('Parler à Mira'), checked: true },
              },
            ],
          }),
        );
        const doc = await get(child.id);
        assert.equal(doc.page.version, 2);
        assert.equal(doc.blocks.length, 3);
        assert.equal(doc.blocks.find((b) => b.id === task)?.parentId, nested);
        const found = searchResultsSchema.parse(
          await json(await request(`${base}/search?q=Dragon`, 1)),
        );
        assert.equal(found[0]?.id, child.id);
        const effects = await pool.query(
          'select (select count(*)::int from audit_logs where resource_id=$1) audit, (select count(*)::int from outbox_events where aggregate_id=$1) events, (select page_version::int from search_documents where page_id=$1) version',
          [child.id],
        );
        assert.deepEqual(effects.rows[0], { audit: 2, events: 2, version: 2 });
      });
      await t.test(
        'two writers on the same version yield one success and one 409; stale batches do not write',
        async () => {
          const results = await Promise.all(
            ['Premier', 'Second'].map((text, index) =>
              request(`${base}/pages/${child.id}`, index, 'PUT', {
                expectedVersion: 2,
                title: child.title,
                operations: [
                  {
                    op: 'update',
                    id: task,
                    schemaVersion: 1,
                    content: { ...content(text), checked: false },
                  },
                ],
              }),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [200, 409]);
          assert.equal((await get(child.id)).page.version, 3);
        },
      );
      await t.test(
        'invalid later operation, cycles, foreign IDs and unsafe links roll back the entire batch',
        async () => {
          const before = await get(child.id);
          for (const bad of [
            { op: 'move', id: p, parentId: task, afterId: null },
            { op: 'update', id: randomUUID(), schemaVersion: 1, content: content('Absent') },
            {
              op: 'update',
              id: task,
              schemaVersion: 1,
              content: {
                checked: false,
                spans: [{ type: 'link', href: 'javascript:alert(1)', content: [] }],
              },
            },
            {
              op: 'insert',
              id: randomUUID(),
              parentId: null,
              afterId: null,
              type: 'core.image',
              schemaVersion: 1,
              content: { fileId: randomUUID(), alt: '', caption: '', width: 512 },
            },
          ]) {
            assert.equal(
              (
                await request(`${base}/pages/${child.id}`, 0, 'PUT', {
                  expectedVersion: 3,
                  title: 'Should roll back',
                  operations: [
                    { op: 'update', id: p, schemaVersion: 1, content: content('Should roll back') },
                    bad,
                  ],
                })
              ).status,
              400,
            );
            assert.deepEqual(await get(child.id), before);
          }
          assert.equal(
            (
              await request(`${base}/pages/${other.id}`, 0, 'PUT', {
                expectedVersion: 1,
                title: other.title,
                operations: [
                  {
                    op: 'insert',
                    id: p,
                    parentId: null,
                    afterId: null,
                    type: 'core.paragraph',
                    schemaVersion: 1,
                    content: content('Collision'),
                  },
                ],
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        'type change, parent inversion and sibling swaps survive SQL constraints',
        async () => {
          await json(
            await request(`${base}/pages/${child.id}`, 0, 'PUT', {
              expectedVersion: 3,
              title: child.title,
              operations: [
                { op: 'move', id: nested, parentId: null, afterId: p },
                { op: 'move', id: p, parentId: nested, afterId: task },
                {
                  op: 'update',
                  id: p,
                  type: 'core.heading',
                  schemaVersion: 1,
                  content: { ...content('Dragon transformé'), level: 2 },
                },
              ],
            }),
          );
          const doc = await get(child.id);
          assert.equal(doc.page.version, 4);
          assert.equal(doc.blocks.find((b) => b.id === p)?.parentId, nested);
          assert.equal(doc.blocks.find((b) => b.id === p)?.type, 'core.heading');
        },
      );
      await t.test(
        'block archive/restore keeps descendants and one version per batch',
        async () => {
          await json(
            await request(`${base}/pages/${child.id}`, 0, 'PUT', {
              expectedVersion: 4,
              title: child.title,
              operations: [{ op: 'archive', id: nested }],
            }),
          );
          assert.equal((await get(child.id)).blocks.length, 0);
          await json(
            await request(`${base}/pages/${child.id}`, 0, 'PUT', {
              expectedVersion: 5,
              title: child.title,
              operations: [{ op: 'restore', id: nested, parentId: null, afterId: null }],
            }),
          );
          assert.equal((await get(child.id)).blocks.length, 3);
        },
      );
      await t.test(
        'archived ancestors hide descendants from reads/search and increment their versions; restore is coherent',
        async () => {
          await json(
            await request(`${base}/pages/${root.id}/archive`, 0, 'POST', { expectedVersion: 1 }),
            201,
          );
          assert.equal((await request(`${base}/pages/${child.id}`)).status, 404);
          assert.equal(
            searchResultsSchema.parse(await json(await request(`${base}/search?q=Dragon`))).length,
            0,
          );
          const tree = pageTreeSchema.parse(await json(await request(`${base}/pages`)));
          assert.ok(!tree.pages.some((p) => p.id === child.id));
          assert.equal(tree.trash[0]?.id, root.id);
          await json(
            await request(`${base}/pages/${root.id}/restore`, 0, 'POST', { expectedVersion: 2 }),
            201,
          );
          assert.equal((await get(child.id)).page.version, 8);
          assert.equal(
            searchResultsSchema.parse(await json(await request(`${base}/search?q=Dragon`))).length,
            1,
          );
        },
      );
      await t.test(
        'concurrent tree mutations cannot create a page cycle; revoked membership stops reads and writes',
        async () => {
          const results = await Promise.all([
            request(`${base}/pages/${root.id}/move`, 0, 'POST', {
              expectedVersion: 3,
              parentId: other.id,
              afterId: null,
            }),
            request(`${base}/pages/${other.id}/move`, 0, 'POST', {
              expectedVersion: 1,
              parentId: root.id,
              afterId: null,
            }),
          ]);
          assert.equal(results.filter((r) => r.status === 201).length, 1);
          assert.ok(results.some((r) => r.status === 400 || r.status === 409));
          await pool.query('delete from workspace_members where workspace_id=$1 and user_id=$2', [
            workspace.id,
            users[1]!.id,
          ]);
          assert.equal((await request(`${base}/search?q=Dragon`, 1)).status, 404);
          assert.equal(
            (
              await request(`${base}/pages/${child.id}`, 1, 'PUT', {
                expectedVersion: 8,
                title: 'Denied',
                operations: [],
              })
            ).status,
            404,
          );
        },
      );
    },
  );
} finally {
  // Exact, random test fixtures only. No database reset and no developer quota deletion.
  for (const id of workspaceIds) await pool.query('delete from workspaces where id=$1', [id]);
  for (const account of users) {
    await pool.query('delete from auth_users where email=$1', [account.email]);
    await pool.query('delete from auth_rate_limits where key like $1', [`${account.ip}|%`]);
  }
  const mail = (await globalThis
    .fetch('http://localhost:8025/api/v1/messages')
    .then((r) => r.json())) as { messages?: { ID: string; To?: { Address: string }[] }[] };
  for (const message of mail.messages ?? [])
    if (message.To?.some((to) => users.some((account) => account.email === to.Address)))
      await globalThis.fetch('http://localhost:8025/api/v1/messages', {
        method: 'DELETE',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ IDs: [message.ID] }),
      });
  await app.close();
  await pool.end();
}
