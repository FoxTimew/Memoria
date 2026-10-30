import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { testDatabase } from '../../apps/collab/src/testing/database.ts';
import { testAuth } from '../../apps/collab/src/testing/auth.ts';
import { representativeDocument } from '../../apps/collab/src/testing/fixture.ts';
import { seedPage, firstText, until } from '../../apps/collab/src/testing/pool-helpers.ts';
import { collaborationServer, sessionVerifier } from '../../apps/collab/src/service/server.ts';
import { readCollabConfig } from '../../apps/collab/src/service/config.ts';
import { decodeDocument } from '../../apps/collab/src/codec.ts';

await test(
  'Isolation proof: actual publication worker loss, in-flight commit, offline edits and revocation',
  { timeout: 90000 },
  async () => {
    const db = await testDatabase(),
      auth = await testAuth(db),
      fixture = await representativeDocument(18);
    const page = await seedPage(db, Y.encodeStateAsUpdate(fixture.doc));
    fixture.doc.destroy();
    const accounts = [await auth.account('Recovery A'), await auth.account('Recovery B')];
    const host = await collaborationServer(
      readCollabConfig({
        ...process.env,
        DATABASE_URL: db.url,
        COLLAB_PORT: '0',
        COLLAB_INTERNAL_PORT: '0',
        COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
      }),
      db.pool,
      sessionVerifier(auth.auth),
    );
    const clients = [],
      observations = [];
    function peer(account) {
      const events = [],
        doc = new Y.Doc();
      const socket = new HocuspocusProviderWebsocket({
        url: host.ingress.url,
        autoConnect: false,
        delay: 1000,
        maxDelay: 5000,
        WebSocketPolyfill: class extends WebSocket {
          constructor(url) {
            super(url, { headers: { cookie: account.cookie, origin: auth.origin } });
          }
        },
      });
      let failed = false;
      const provider = new HocuspocusProvider({
        name: page.name,
        document: doc,
        websocketProvider: socket,
        awareness: null,
        token: '',
        forceSyncInterval: 15000,
        onOpen: () => events.push({ event: 'open', at: Date.now() }),
        onClose: ({ event }) => events.push({ event: 'close', at: Date.now(), code: event.code }),
        onAuthenticationFailed: () => {
          failed = true;
          socket.disconnect();
        },
      });
      provider.attach();
      void socket.connect();
      const c = {
        doc,
        provider,
        socket,
        events,
        get failed() {
          return failed;
        },
      };
      clients.push(c);
      return c;
    }
    const [a, b] = accounts.map(peer);
    const rev = async () =>
      Number(
        (
          await db.pool.query(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
            [page.page],
          )
        ).rows[0].content_revision,
      );
    const same = () =>
      JSON.stringify(decodeDocument(a.doc)) === JSON.stringify(decodeDocument(b.doc));
    try {
      await until(() => a.provider.synced && b.provider.synced, 'initial sync');
      firstText(a.doc).insert(0, 'before crash ');
      await until(async () => (await rev()) === 1 && same(), 'initial durability');
      const epoch = host.hocus.epoch,
        started = Date.now();
      await host.hocus.worker.terminate();
      await until(
        () =>
          a.events.some((e) => e.event === 'close') && b.events.some((e) => e.event === 'close'),
        'physical sockets close',
      );
      firstText(a.doc).insert(0, 'offline survives ');
      await until(
        () =>
          host.hocus.epoch > epoch &&
          !host.hocus.restarting &&
          a.provider.synced &&
          b.provider.synced &&
          same(),
        'automatic reconnect',
      );
      await until(async () => (await rev()) === 2, 'offline write durable');
      assert(firstText(b.doc).toString().includes('offline survives'));
      assert.equal(host.connections.size, 2);
      observations.push({
        case: 'idle worker death and offline edit',
        elapsedMs: Date.now() - started,
        epoch: host.hocus.epoch,
      });

      const append = host.store.append.bind(host.store);
      let release,
        committed = false,
        entered;
      const gate = new Promise((r) => {
        release = r;
      });
      const arrived = new Promise((r) => {
        entered = r;
      });
      host.store.append = async (...args) => {
        const result = await append(...args);
        if (!committed) {
          committed = true;
          entered();
          await gate;
        }
        return result;
      };
      const before = await rev();
      firstText(a.doc).insert(0, 'committed without publication ');
      await arrived;
      assert.equal(await rev(), before + 1);
      const duringEpoch = host.hocus.epoch;
      await host.hocus.worker.terminate();
      release();
      await until(
        () =>
          host.hocus.epoch > duringEpoch &&
          !host.hocus.restarting &&
          a.provider.synced &&
          b.provider.synced &&
          same(),
        'durable in-flight replay',
      );
      assert(firstText(b.doc).toString().includes('committed without publication'));
      assert.equal(
        await rev(),
        before + 1,
        'Native duplicate sync must not create a second durable revision',
      );
      host.store.append = append;
      const stored = await host.store.load(page.page, page.generation),
        doc = new Y.Doc();
      Y.applyUpdate(doc, Y.mergeUpdates([stored.snapshot, ...stored.updates]));
      assert.deepEqual(decodeDocument(doc), decodeDocument(b.doc));
      doc.destroy();
      observations.push({
        case: 'SQL commit survives publication death',
        revision: await rev(),
        epoch: host.hocus.epoch,
      });

      const failure = host.hocus.onFailure;
      let resumeRestart;
      const restartGate = new Promise((r) => {
        resumeRestart = r;
      });
      host.hocus.onFailure = async () => {
        await failure();
        await restartGate;
      };
      await host.hocus.worker.terminate();
      await until(() => host.hocus.restarting, 'restart blocked for revocation race');
      firstText(a.doc).insert(0, 'revoked local text ');
      await db.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
        db.workspace,
        accounts[0].user,
      ]);
      resumeRestart();
      await until(() => a.failed && b.provider.synced, 'revocation denies cached reconnect');
      assert(!firstText(b.doc).toString().includes('revoked local text'));
      const previous = await rev();
      firstText(b.doc).insert(0, 'healthy after recovery ');
      await until(async () => (await rev()) === previous + 1, 'remaining member writes');
      await until(
        () =>
          host.connections.size === 1 &&
          host.hocus.clients.size === 1 &&
          host.ingress.admission.pendingBytes === 0,
        'no stale connections or frame charges',
      );
      assert.equal(host.rooms.size, 1);
      assert(host.memory.chargedBytes <= 1024 ** 3);
      observations.push({
        case: 'revoked user refused, healthy peer writes',
        connections: host.connections.size,
        pendingBytes: host.ingress.admission.pendingBytes,
        chargedBytes: host.memory.chargedBytes,
      });
      await mkdir('.local/isolation', { recursive: true });
      await writeFile(
        '.local/isolation/recovery.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            scope:
              'Functional actual worker terminate and automatic native provider reconnect. Not the real front, not CPU saturation, not a latency qualification.',
            observations,
            clients: clients.map((c) => c.events),
          },
          null,
          2,
        ) + '\n',
      );
    } finally {
      for (const c of clients) {
        c.provider.destroy();
        c.socket.destroy();
        c.doc.destroy();
      }
      await host.close();
      await auth.pool.end();
      await db.close();
    }
  },
);
