import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID, randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { resolveAccess } from '../service/access.ts';
import { decodeDocument } from '../codec.ts';
import { internalSignature } from '@memoria/auth/collaboration';
async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 10000) {
  const end = Date.now() + timeout;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('Timeout: ' + label);
    await delay(20);
  }
}
test(
  'Production service: twelve transport and durability scenarios',
  { timeout: 120000 },
  async (t) => {
    const db = await testDatabase(),
      authentication = await testAuth(db),
      fixture = await representativeDocument(18);
    const snapshot = Y.encodeStateAsUpdate(fixture.doc),
      generation = db.generation,
      room = `${db.workspace}:${db.page}:${generation}`;
    await db.pool.query(
      'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
      [
        db.page,
        db.workspace,
        generation,
        Buffer.from(snapshot),
        snapshot.length,
        Buffer.byteLength(JSON.stringify(decodeDocument(fixture.doc))),
      ],
    );
    const readers = new Set<string>(),
      incidents: object[] = [];
    const config = readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
    });
    const host = await collaborationServer(config, db.pool, sessionVerifier(authentication.auth), {
      report: (e) => incidents.push(e),
      access: async (database, requests) => {
        const result = await resolveAccess(database, requests);
        for (const access of result.values()) if (readers.has(access.user)) access.level = 'read';
        return result;
      },
    });
    interface Peer {
      doc: Y.Doc;
      provider: HocuspocusProvider;
      socket: HocuspocusProviderWebsocket;
      received: { status: string; revision: number; receipt: string }[];
      readonly failed: boolean;
      readonly closed: boolean;
      destroy(): void;
    }
    const peers: Peer[] = [];
    function peer(
      cookie: string,
      origin = authentication.origin,
      name = room,
      doc = new Y.Doc(),
    ): Peer {
      const socket = new HocuspocusProviderWebsocket({
        url: host.ingress.url,
        autoConnect: false,
        maxAttempts: 1,
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string) {
            super(url, { headers: { cookie, origin } });
          }
        },
      });
      const received: { status: string; revision: number; receipt: string }[] = [];
      let failed = false,
        closed = false;
      const provider = new HocuspocusProvider({
        name,
        document: doc,
        websocketProvider: socket,
        awareness: null,
        token: '',
        onOpen: () => {
          closed = false;
        },
        onStateless: ({ payload }) => {
          const receipt = JSON.parse(payload) as (typeof received)[number] & { kind?: string };
          if (receipt.kind !== 'sync') received.push(receipt);
        },
        onAuthenticationFailed: () => {
          failed = true;
          socket.disconnect();
        },
        onClose: () => {
          closed = true;
          socket.disconnect();
        },
      });
      const value = {
        doc,
        provider,
        socket,
        received,
        get failed() {
          return failed;
        },
        get closed() {
          return closed;
        },
        destroy() {
          provider.destroy();
          socket.destroy();
          doc.destroy();
        },
      };
      peers.push(value);
      provider.attach();
      void socket.connect();
      return value;
    }
    const text = (doc: Y.Doc) =>
      [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
        (n): n is Y.XmlText => n instanceof Y.XmlText,
      )!;
    const card = (doc: Y.Doc) =>
      [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
        (n): n is Y.XmlElement =>
          n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
      )!;

    const revision = async () =>
      Number(
        (
          await db.pool.query(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
            [db.page],
          )
        ).rows[0].content_revision,
      );
    const projected = async () =>
      Number(
        (
          await db.pool.query(
            'SELECT projection_revision FROM collaboration_documents WHERE page_id=$1',
            [db.page],
          )
        ).rows[0].projection_revision,
      );
    const matches = (a: Y.Doc, b: Y.Doc) =>
      JSON.stringify(decodeDocument(a)) === JSON.stringify(decodeDocument(b));
    const alice = await authentication.account('Alice'),
      bob = await authentication.account('Bob'),
      attacker = await authentication.account('Invalid writer');
    const a = peer(alice.cookie),
      b = peer(bob.cookie);
    try {
      await t.test('01 Better Auth and nested BlockNote document', async () => {
        await until(() => a.provider.synced && b.provider.synced, 'sync');
        assert(matches(a.doc, b.doc));
        assert.equal(decodeDocument(a.doc).length, 18);
      });
      await t.test(
        '02 SQL commit precedes broadcast and confirms every merged contributor',
        async () => {
          await db.client.query('BEGIN');
          await db.client.query('SELECT id FROM pages WHERE id=$1 FOR NO KEY UPDATE', [db.page]);
          const third = peer(attacker.cookie);
          await until(() => third.provider.synced, 'third');
          const before = text(b.doc).toString();
          text(a.doc).insert(0, 'A');
          await delay(60);
          card(b.doc).setAttribute('health', 66 as unknown as string);
          card(third.doc).setAttribute('biography', 'third');
          await delay(100);
          assert.equal(text(b.doc).toString(), before);
          assert.equal(a.received.length, 0);
          assert.equal(await revision(), 0);
          await db.client.query('COMMIT');
          await until(
            () => a.received.length === 1 && b.received.length === 1 && third.received.length === 1,
            'receipts',
          );
          assert.equal(b.received[0]!.revision, third.received[0]!.revision);
          third.destroy();
        },
      );
      await t.test('03 simultaneous text and independent character fields converge', async () => {
        card(a.doc).setAttribute('displayName', 'Shared name');
        card(b.doc).setAttribute('biography', 'Shared bio');
        text(a.doc).insert(0, 'left');
        text(b.doc).insert(0, 'right');
        await until(() => matches(a.doc, b.doc), 'converge');
        assert.equal(card(a.doc).getAttribute('biography'), 'Shared bio');
        card(a.doc).setAttribute('health', 75 as unknown as string);
        card(b.doc).setAttribute('health', 25 as unknown as string);
        await until(() => matches(a.doc, b.doc), 'same field');
      });
      await t.test('04 offline edits merge after session recheck and durable replay', async () => {
        a.socket.disconnect();
        await until(() => host.connections.size === 1, 'disconnect');
        text(a.doc).insert(0, 'offline');
        text(b.doc).delete(0, 2);
        await delay(100);
        await a.socket.connect();
        await until(() => a.provider.synced && matches(a.doc, b.doc), 'offline');
        const loaded = await host.store.load(db.page, generation),
          restored = new Y.Doc();
        restored.getXmlFragment('prosemirror');
        Y.applyUpdate(restored, loaded.snapshot);
        for (const u of loaded.updates) Y.applyUpdate(restored, u);
        assert(matches(restored, b.doc));
        restored.destroy();
      });
      await t.test(
        '05 projection failure rolls back effects while typing remains durable, then retries',
        async () => {
          await until(async () => (await projected()) === (await revision()), 'projection settled');
          await db.pool.query(
            `CREATE FUNCTION test_projection_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'injected projection failure'; END $$; CREATE TRIGGER test_projection_failure BEFORE INSERT ON outbox_events FOR EACH ROW EXECUTE FUNCTION test_projection_failure()`,
          );
          const before = await projected(),
            events = Number(
              (await db.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count,
            );
          card(a.doc).setAttribute('displayName', 'Projection A');
          card(b.doc).setAttribute('biography', 'Projection B');
          await until(() => incidents.length > 0, 'projection incident');
          assert.equal(await projected(), before);
          assert.equal(
            Number((await db.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count),
            events,
          );
          text(b.doc).insert(0, 'while projection unavailable');
          await until(async () => (await revision()) > before + 1, 'typing');
          assert(!a.closed && !b.closed);
          await db.pool.query(
            'DROP TRIGGER test_projection_failure ON outbox_events; DROP FUNCTION test_projection_failure()',
          );
          await until(async () => (await projected()) === (await revision()), 'retry');
          const rows = (
            await db.pool.query(
              'SELECT id,parent_id AS "parentId",position,type,schema_version AS "schemaVersion",content FROM blocks WHERE page_id=$1',
              [db.page],
            )
          ).rows;
          const sorted = (rows: { id: string }[]) => rows.sort((x, y) => x.id.localeCompare(y.id));
          assert.deepEqual(sorted(rows), sorted(decodeDocument(b.doc)));
          assert.equal(
            Number((await db.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count),
            events + 1,
          );
          const audit = (
            await db.pool.query(
              "SELECT count(*) FROM audit_logs WHERE (metadata->>'contentRevision')::bigint=$1",
              [await projected()],
            )
          ).rows[0];
          assert.equal(Number(audit.count), 2);
        },
      );
      await t.test(
        '06 signed API command waits own projection; retry survives automatic compaction',
        async () => {
          const id = decodeDocument(b.doc).find((b) => b.type === 'gamedev.character-card')!;
          const command = {
            action: 'write',
            workspace: db.workspace,
            page: db.page,
            user: alice.user,
            session: alice.session,
            generation,
            expectedRevision: await revision(),
            receipt: randomUUID(),
            operations: [
              {
                op: 'update',
                id: id.id,
                schemaVersion: 2,
                content: { ...id.content, displayName: 'API write' },
              },
            ],
          };
          const call = async () => {
            const body = JSON.stringify(command);
            return fetch(host.internal.url, {
              method: 'POST',
              headers: {
                'content-type': 'application/json',
                ...internalSignature(
                  config.COLLAB_INTERNAL_SECRET,
                  '/internal/collaboration',
                  body,
                ),
              },
              body,
            });
          };
          const response = await call();
          assert.equal(response.status, 200);
          const result = (await response.json()) as { revision: number };
          assert((await projected()) >= result.revision);
          await until(
            () => card(b.doc).getAttribute('displayName') === 'API write',
            'API broadcast',
          );
          assert.equal(
            Number(
              (await db.pool.query('SELECT count(*) FROM collaboration_updates')).rows[0].count,
            ),
            0,
          );
          const next = await revision();
          assert.equal((await call()).status, 200);
          assert.equal(await revision(), next);
          text(a.doc).insert(0, 'after compaction');
          await until(() => matches(a.doc, b.doc), 'old Yjs identities');
        },
      );
      await t.test(
        '07 no cookie, foreign origin and generation refused before document load',
        async () => {
          const missing = peer(''),
            foreign = peer(alice.cookie, 'https://foreign.test'),
            wrong = peer(
              alice.cookie,
              authentication.origin,
              `${db.workspace}:${db.page}:${randomUUID()}`,
            );
          await until(() => [missing, foreign, wrong].every((p) => p.closed || p.failed), 'denied');
          for (const p of [missing, foreign, wrong])
            assert.equal(p.doc.getXmlFragment('prosemirror').length, 0);
        },
      );
      await t.test('08 read-only access rejects live updates and offline SyncStep2', async () => {
        const reader = await authentication.account('Reader');
        readers.add(reader.user);
        const r = peer(reader.cookie);
        await until(() => r.provider.synced, 'reader');
        const before = await revision();
        text(r.doc).insert(0, 'forbidden');
        await until(() => r.closed, 'reader close');
        assert.equal(await revision(), before);
        const offline = new Y.Doc();
        Y.applyUpdate(offline, Y.encodeStateAsUpdate(b.doc));
        text(offline).insert(0, 'forbidden offline');
        const r2 = peer(reader.cookie, authentication.origin, room, offline);
        await until(() => r2.closed, 'read only sync');
        assert.equal(await revision(), before);
      });
      await t.test(
        '09 rejected batch isolates invalid loop while two healthy writers continue',
        async () => {
          const bad = peer(attacker.cookie);
          await until(() => bad.provider.synced, 'bad sync');
          await db.client.query('BEGIN');
          await db.client.query('SELECT id FROM pages WHERE id=$1 FOR NO KEY UPDATE', [db.page]);
          text(a.doc).insert(0, 'barrier');
          await delay(60);
          card(bad.doc).setAttribute('health', -1 as unknown as string);
          text(b.doc).insert(0, 'healthy');
          await until(() => host.rooms.get(room)!.queue.waiting === 2, 'mixed queue');
          await db.client.query('COMMIT');
          await until(() => bad.closed && matches(a.doc, b.doc), 'isolated rejection');
          for (let i = 0; i < 2; i++) {
            const badNext = peer(attacker.cookie);
            await until(() => badNext.provider.synced, 'retry bad');
            card(badNext.doc).setAttribute('health', -2 as unknown as string);
            for (let j = 0; j < 10; j++) {
              text(a.doc).insert(0, 'x');
              text(b.doc).insert(0, 'y');
              await delay(50);
            }
            await until(() => badNext.closed, 'rejected');
            assert(!a.closed && !b.closed);
          }
          assert(host.refusals.blocked(attacker.user));
          const blocked = peer(attacker.cookie);
          await until(() => blocked.closed || blocked.failed, 'blocked reconnect');
          assert(!a.closed && !b.closed);
        },
      );
      await t.test(
        '10 session deletion closes every tab via fallback within five seconds',
        async () => {
          const a2 = peer(alice.cookie);
          await until(() => a2.provider.synced, 'second tab');
          await db.pool.query('ALTER TABLE auth_sessions DISABLE TRIGGER collab_notify_session');
          const start = Date.now();
          await db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [alice.session]);
          await until(() => a.closed && a2.closed, 'logout fallback', 5500);
          assert(Date.now() - start < 5500);
          assert(!b.closed);
        },
      );
      await t.test('11 membership deletion closes only affected user', async () => {
        await db.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
          db.workspace,
          bob.user,
        ]);
        await until(() => b.closed, 'membership notify');
      });
      await t.test(
        '12 ancestor archive revokes descendants and leader loss closes remaining sockets',
        async () => {
          const last = await authentication.account('Last');
          const p = peer(last.cookie);
          await until(() => p.provider.synced, 'last');
          const parent = randomUUID();
          await db.pool.query(
            "INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'parent')",
            [parent, db.workspace],
          );
          await db.pool.query('UPDATE pages SET parent_id=$2 WHERE id=$1', [db.page, parent]);
          await db.pool.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [parent]);
          await until(() => p.closed, 'ancestor');
          await db.pool.query('UPDATE pages SET deleted_at=NULL WHERE id=$1', [parent]);
          const fresh = peer(last.cookie);
          await until(() => fresh.provider.synced, 'leader client');
          await db.pool.query('SELECT pg_terminate_backend($1)', [host.leadership.fence.pid]);
          await until(() => fresh.closed, 'leader loss');
        },
      );
    } finally {
      await db.client.query('ROLLBACK');
      for (const p of peers) p.destroy();
      await host.close();
      fixture.doc.destroy();
      await authentication.pool.end();
      await db.close();
    }
  },
);
