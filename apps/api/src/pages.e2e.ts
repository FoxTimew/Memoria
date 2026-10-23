import 'reflect-metadata';
import { resolve } from 'node:path';
import { testDatabase } from '../../collab/src/testing/database.ts';
import { collaborationServer } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
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

process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
const fixture = await testDatabase();
process.env.DATABASE_URL = fixture.url;
const collab = await collaborationServer(
  readCollabConfig({ ...process.env, COLLAB_PORT: '0', COLLAB_INTERNAL_PORT: '0' }),
  fixture.pool,
  async () => {
    throw new Error('API commands only');
  },
);
process.env.COLLAB_INTERNAL_URL = collab.internal.url;
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
    'Production Nest + BlockWriteService + collaboration + PostgreSQL',
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
        nested = randomUUID();
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

      let generation = '',
        contentRevision = 1;
      const write = async (
        operations: unknown[],
        index = 0,
        expected = contentRevision,
        receipt = randomUUID(),
      ) =>
        request(`${base}/pages/${child.id}/content`, index, 'PUT', {
          generation,
          expectedRevision: expected,
          receipt,
          operations,
        });
      await t.test(
        'Nest session injection and BlockWriteService wait for projected nested content',
        async () => {
          const opened = (await json(
            await request(`${base}/pages/${child.id}/collaboration`, 0, 'POST', {}),
            201,
          )) as { generation: string; contentRevision: number };
          generation = opened.generation;
          contentRevision = opened.contentRevision;
          const result = (await json(
            await write(
              [
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
              ],
              1,
            ),
          )) as { contentRevision: number; projectionRevision: number };
          contentRevision = result.contentRevision;
          assert(result.projectionRevision >= contentRevision);
          const doc = await get(child.id);
          assert.equal(doc.page.version, 1);
          assert.equal(doc.blocks.find((b) => b.id === nested)?.parentId, p);
          assert.equal(
            searchResultsSchema.parse(await json(await request(`${base}/search?q=Dragon`, 1)))[0]
              ?.id,
            child.id,
          );
        },
      );
      await t.test(
        'command idempotency and stale content revision do not change relational version',
        async () => {
          const before = contentRevision,
            receipt = randomUUID(),
            operations = [
              { op: 'update', id: p, schemaVersion: 1, content: content('Dragon bleu') },
            ];
          const result = (await json(await write(operations, 0, before, receipt))) as {
            contentRevision: number;
          };
          contentRevision = result.contentRevision;
          assert.equal((await write(operations, 0, before, receipt)).status, 200);
          assert.equal((await write(operations, 0, before)).status, 409);
          assert.equal((await get(child.id)).page.version, 1);
        },
      );
      await t.test(
        'invalid candidates, foreign files and cross-page IDs cannot reach the journal',
        async () => {
          const before = await get(child.id);
          for (const operation of [
            { op: 'move', id: p, parentId: nested, afterId: null },
            {
              op: 'update',
              id: p,
              schemaVersion: 1,
              content: { spans: [{ type: 'link', href: 'javascript:alert(1)', content: [] }] },
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
            const response = await write([operation]);
            assert([400, 403, 409].includes(response.status), await response.text());
            assert.deepEqual(await get(child.id), before);
          }
          const otherDoc = (await json(
            await request(`${base}/pages/${other.id}/collaboration`, 0, 'POST', {}),
            201,
          )) as { generation: string; contentRevision: number };
          const collision = await request(`${base}/pages/${other.id}/content`, 0, 'PUT', {
            generation: otherDoc.generation,
            expectedRevision: otherDoc.contentRevision,
            receipt: randomUUID(),
            operations: [
              {
                op: 'insert',
                id: p,
                parentId: null,
                afterId: null,
                type: 'core.paragraph',
                schemaVersion: 1,
                content: content('collision'),
              },
            ],
          });
          assert.equal(collision.status, 409);
        },
      );
      await t.test(
        'rename retains relational 409 and legacy content PUT cannot bypass Yjs',
        async () => {
          const results = await Promise.all(
            ['Premier', 'Second'].map((title) =>
              request(`${base}/pages/${child.id}/rename`, 0, 'POST', { expectedVersion: 1, title }),
            ),
          );
          assert.deepEqual(results.map((r) => r.status).sort(), [201, 409]);
          assert.equal((await get(child.id)).page.version, 2);
          assert.equal(
            (
              await request(`${base}/pages/${child.id}`, 0, 'PUT', {
                expectedVersion: 2,
                title: 'Legacy',
                operations: [{ op: 'archive', id: p }],
              })
            ).status,
            409,
          );
        },
      );
      await t.test(
        'archive/restore hides descendants from search and retains document generation',
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
          assert(!tree.pages.some((p) => p.id === child.id));
          await json(
            await request(`${base}/pages/${root.id}/restore`, 0, 'POST', { expectedVersion: 2 }),
            201,
          );
          const reopened = (await json(
            await request(`${base}/pages/${child.id}/collaboration`, 0, 'POST', {}),
            201,
          )) as { generation: string };
          assert.equal(reopened.generation, generation);
          assert.equal(
            searchResultsSchema.parse(await json(await request(`${base}/search?q=Dragon`))).length,
            1,
          );
        },
      );
      await t.test('tree cycles and revoked membership remain denied', async () => {
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
        await pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
          workspace.id,
          users[1]!.id,
        ]);
        assert.equal((await request(`${base}/search?q=Dragon`, 1)).status, 404);
        assert.equal((await write([{ op: 'archive', id: p }], 1)).status, 403);
      });
    },
  );
} finally {
  await collab.close();

  // All SQL fixtures live in one isolated schema; DROP SCHEMA below cleans them atomically.
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

  await fixture.close();
}
