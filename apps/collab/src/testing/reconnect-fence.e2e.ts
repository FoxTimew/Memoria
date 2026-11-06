import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { CollaborationClient } from '../../../web/src/lib/collaboration-client.ts';
import { decodeDocument } from '../codec.ts';

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const deadline = Date.now() + 12000;
  while (!(await predicate())) {
    if (Date.now() > deadline) throw Error('Timeout: ' + label);
    await delay(20);
  }
}
const text = (doc: Y.Doc) =>
  [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
    (n): n is Y.XmlText => n instanceof Y.XmlText,
  )!;

test(
  'Actual front client: fencing rollback, retry, invalid content and revocation',
  { timeout: 90000 },
  async (t) => {
    const db = await testDatabase(),
      authentication = await testAuth(db);
    const host = await collaborationServer(
      readCollabConfig({
        ...process.env,
        DATABASE_URL: db.url,
        COLLAB_PORT: '0',
        COLLAB_INTERNAL_PORT: '0',
        COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
      }),
      db.pool,
      sessionVerifier(authentication.auth),
      { report: () => {} },
    );
    const state = await host.store.open({ ...db, key: 'fixture' });
    const room = `${db.workspace}:${db.page}:${state.generation}`;
    const clients: CollaborationClient[] = [];
    const closed: { client: number; code: number; reason: string }[] = [];
    const peers = async (name: string) => {
      const account = await authentication.account(name),
        index = clients.length;
      let checks = 0;
      const client = new CollaborationClient(
        room,
        state.generation,
        {
          url: host.ingress.url,
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string) {
              super(url, { headers: { cookie: account.cookie, origin: authentication.origin } });
              this.on('close', (code, reason) =>
                closed.push({ client: index, code, reason: reason.toString() }),
              );
            }
          },
        },
        async () => {
          checks++;
          try {
            await host.store.authorize({
              workspace: db.workspace,
              page: db.page,
              user: account.user,
              session: account.session,
              key: name,
            });
          } catch {
            throw { status: 403 };
          }
        },
      );
      clients.push(client);
      client.connect();
      await until(() => client.state.loaded && client.state.phase === 'saved', 'client loaded');
      return { client, index, account, checks: () => checks };
    };
    const pauseRenewal = async () => {
      // Fixture only: stop the heartbeat timer, then expire the actual PostgreSQL lease.
      // No mocked assertFence, authorization, transaction, close code or retry loop.
      await Reflect.get(host.leadership, 'heartbeat');
      clearTimeout(Reflect.get(host.leadership, 'timer'));
      await db.pool.query(
        "UPDATE collaboration_leadership SET lease_until=clock_timestamp()-interval '1 second' WHERE id=1",
      );
    };
    const renew = () =>
      Reflect.apply(Reflect.get(host.leadership, 'renew'), host.leadership, []) as Promise<void>;
    const revision = async () =>
      Number(
        (
          await db.pool.query(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
            [db.page],
          )
        ).rows[0].content_revision,
      );
    try {
      const author = await peers('Author'),
        reader = await peers('Reader');
      await t.test(
        'expired SQL fence rolls back; 1013 retries and confirms the retained Yjs diff',
        async () => {
          const before = await revision(),
            checks = author.checks();
          await pauseRenewal();
          text(author.client.doc).insert(0, 'retained-after-SQL-fence ');
          await until(
            () => closed.some((c) => c.client === author.index && c.code === 1013),
            'technical close',
          );
          assert.equal(
            closed.find((c) => c.client === author.index)!.reason,
            'LEADERSHIP_UNAVAILABLE',
          );
          assert.equal(await revision(), before);
          assert(!text(reader.client.doc).toString().includes('retained-after-SQL-fence'));
          assert(author.client.state.dirty);
          assert.notEqual(author.client.state.phase, 'blocked');
          assert.equal(host.refusals.blocked(author.account.user), false);
          await renew();
          await until(
            () =>
              author.client.state.phase === 'saved' &&
              text(reader.client.doc).toString().includes('retained-after-SQL-fence'),
            'durability and broadcast after retry',
          );
          assert(author.checks() > checks);
          assert.equal(await revision(), before + 1);
          assert.deepEqual(decodeDocument(author.client.doc), decodeDocument(reader.client.doc));
        },
      );
      await t.test(
        'stale local fence also retries, with no relaxation of the 2.5 second guard',
        async () => {
          const count = closed.length;
          await pauseRenewal();
          await delay(2600);
          text(author.client.doc).insert(0, 'retained-after-local-fence ');
          await until(
            () => closed.slice(count).some((c) => c.client === author.index && c.code === 1013),
            'local fence close',
          );
          await renew();
          await until(
            () =>
              author.client.state.phase === 'saved' &&
              text(reader.client.doc).toString().includes('retained-after-local-fence'),
            'local fence recovery',
          );
        },
      );
      await t.test(
        'a revoked membership between failure and retry cannot submit its offline text',
        async () => {
          const victim = await peers('Revoked'),
            before = await revision();
          await pauseRenewal();
          text(victim.client.doc).insert(0, 'must-stay-local ');
          await until(
            () => closed.some((c) => c.client === victim.index && c.code === 1013),
            'victim technical close',
          );
          await db.pool.query(
            'DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
            [db.workspace, victim.account.user],
          );
          await renew();
          await until(() => victim.client.state.phase === 'blocked', 'fresh access denial');
          assert.equal(await revision(), before);
          assert(text(victim.client.doc).toString().includes('must-stay-local'));
          assert(!text(reader.client.doc).toString().includes('must-stay-local'));
        },
      );
      await t.test('typing during reauthentication follows the complete offline diff', async () => {
        const writer = await peers('Handshake');
        writer.client.socket.disconnect();
        await until(() => writer.client.state.phase === 'offline', 'offline writer');
        text(writer.client.doc).insert(0, 'offline dependency ');
        await delay(150); // Its ordinary flush is dropped while disconnected.
        const extension = host.hocus.configuration.extensions.find(
          (e) => e.onAuthenticate === host.hocus.configuration.onAuthenticate,
        )!;
        const authenticate = extension.onAuthenticate!;
        const synchronize = extension.beforeSync!;
        const order: number[] = [];
        extension.beforeSync = async (data) => {
          if (data.type === 0 && data.context.user === writer.account.user) await delay(250);
          if (data.context.user === writer.account.user) {
            order.push(data.type);
            console.log(
              JSON.stringify({
                event: 'handshake-order',
                syncType: data.type,
                bytes: data.payload.length,
              }),
            );
          }
          try {
            return await synchronize(data);
          } catch (error) {
            const replay = new Y.Doc();
            replay.getXmlFragment('prosemirror');
            Y.applyUpdate(replay, Y.encodeStateAsUpdate(data.document));
            Y.applyUpdate(replay, data.payload);
            let reason = 'VALID_FULL_CODEC';
            try {
              decodeDocument(replay);
            } catch (e) {
              reason =
                e instanceof Error && e.message === 'Unresolved Yjs dependencies'
                  ? 'UNRESOLVED_DEPENDENCIES'
                  : 'OTHER_CODEC_REFUSAL';
            }
            console.log(
              JSON.stringify({
                event: 'handshake-rejected',
                syncType: data.type,
                reason,
                pendingStructs: Boolean(replay.store.pendingStructs),
                pendingDs: Boolean(replay.store.pendingDs),
              }),
            );
            replay.destroy();
            throw error;
          }
        };
        extension.onAuthenticate = async (data) => {
          await delay(250); // Test interleaving only: actual auth and rights checks still run.
          return authenticate(data);
        };
        const edit = () =>
          setTimeout(() => text(writer.client.doc).insert(0, 'during handshake '), 40);
        writer.client.provider.on('open', edit);
        try {
          writer.client.connect();
          await until(() => writer.client.state.phase === 'saved', 'handshake edits confirmed');
          await until(
            () => text(reader.client.doc).toString().includes('during handshake'),
            'handshake convergence',
          );
          assert(text(reader.client.doc).toString().includes('offline dependency'));
          assert.deepEqual(
            order.slice(0, 2),
            [0, 1],
            'complete offline diff precedes incremental edits',
          );
          assert(!closed.some((c) => c.client === writer.index && c.code === 1008));
        } finally {
          writer.client.provider.off('open', edit);
          extension.onAuthenticate = authenticate;
          extension.beforeSync = synchronize;
        }
      });
      await t.test('invalid content still closes 1008 and stops the actual client', async () => {
        const attacker = await peers('Invalid'),
          before = await revision();
        attacker.client.doc.getMap('forbidden-root').set('private', 'LEADERSHIP_UNAVAILABLE');
        await until(() => attacker.client.state.phase === 'blocked', 'invalid content blocked');
        assert(closed.some((c) => c.client === attacker.index && c.code === 1008));
        assert.equal(await revision(), before);
        assert(!reader.client.doc.share.has('forbidden-root'));
      });
    } finally {
      for (const client of clients) client.destroy();
      await host.close();
      await authentication.pool.end();
      await db.close();
    }
  },
);
