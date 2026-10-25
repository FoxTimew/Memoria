import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { representativeDocument } from './fixture.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { decodeDocument } from '../codec.ts';
import { firstText, peer, seedPage, until } from './pool-helpers.ts';
import { ValidationPool } from '../service/validation-pool.ts';
import { IncrementalValidator } from '../service/incremental-validator.ts';

test(
  'Shared worker failure reloads every affected replica, including an in-flight durable commit',
  { timeout: 30000 },
  async () => {
    const db = await testDatabase(),
      authentication = await testAuth(db),
      account = await authentication.account('Pool recovery');
    const host = await collaborationServer(
      readCollabConfig({
        ...process.env,
        DATABASE_URL: db.url,
        COLLAB_PORT: '0',
        COLLAB_INTERNAL_PORT: '0',
        COLLAB_VALIDATION_WORKERS: '2',
      }),
      db.pool,
      sessionVerifier(authentication.auth),
    );
    await host.projections.close();
    const fixture = await representativeDocument(18),
      pages = [],
      peers: ReturnType<typeof peer>[] = [];
    const append = host.store.append.bind(host.store);
    let releaseCommit = () => {};
    try {
      for (let i = 0; i < 4; i++) {
        const page = await seedPage(db, Y.encodeStateAsUpdate(fixture.doc));
        pages.push(page);
        const client = peer(host.ingress.url, page.name, account.cookie);
        peers.push(client);
        await until(() => client.provider.synced, 'peer ready');
      }
      assert.equal(host.validators.stats.length, 2);
      assert.deepEqual(
        host.validators.stats.map((s) => s.replicas),
        [2, 2],
      );
      const target = host.rooms.get(pages[0]!.name)!,
        worker = target.replica.workerId;
      const affected = pages
        .map((p, i) => ({ room: host.rooms.get(p.name)!, i }))
        .filter(({ room }) => room.replica.workerId === worker);
      const unaffected = pages.findIndex(
        (p) => host.rooms.get(p.name)!.replica.workerId !== worker,
      );
      let durable = false;
      const barrier = new Promise<void>((resolve) => {
        releaseCommit = resolve;
      });

      host.store.append = async (...args) => {
        const result = await append(...args);
        if (args[2][0]!.identity.page === target.page && !durable) {
          durable = true;
          await barrier;
        }
        return result;
      };
      firstText(peers[0]!.doc).insert(0, 'Durable before crash ');
      await until(() => durable, 'SQL commit');
      await host.validators.terminateWorker(worker);
      await until(() => affected.every(({ i }) => peers[i]!.closed), 'affected sockets closed');
      assert(target.recovering);
      assert.equal(peers[0]!.receipts.length, 0);
      firstText(peers[unaffected]!.doc).insert(0, 'Unaffected worker ');
      await until(() => peers[unaffected]!.receipts.length === 1, 'unaffected writer confirmed');
      assert.equal(peers[unaffected]!.closed, false);
      releaseCommit();
      await until(
        () => affected.every(({ room }) => !room.fatal && !room.recovering),
        'PG recovery',
      );
      assert.equal(target.revision, 1);
      assert.deepEqual(decodeDocument(target.doc), decodeDocument(peers[0]!.doc));
      for (const { room } of affected) {
        assert.notEqual(room.replica.workerId, worker);
        assert.deepEqual(await room.replica.inspect(), decodeDocument(room.doc));
      }
      const reconnect = peer(host.ingress.url, pages[0]!.name, account.cookie);
      peers.push(reconnect);
      await until(() => reconnect.provider.synced, 'reconnect after worker crash');
      assert.deepEqual(decodeDocument(reconnect.doc), decodeDocument(target.doc));
      firstText(reconnect.doc).insert(0, 'Recovered writer ');
      await until(() => reconnect.receipts.length === 1, 'new durable write');
      assert.equal(target.revision, 2);
      await host.projections.project(target.page, target.generation);
      const state = (
        await db.pool.query(
          'SELECT content_revision,projection_revision FROM collaboration_documents WHERE page_id=$1',
          [target.page],
        )
      ).rows[0];
      assert.equal(Number(state.content_revision), 2);
      assert.equal(Number(state.projection_revision), 2);
    } finally {
      releaseCommit();
      host.store.append = append;
      peers.forEach((p) => p.destroy());
      fixture.doc.destroy();
      await host.close();
      await authentication.pool.end();
      await db.close();
    }
  },
);

test('A long replay crosses bounded worker messages and keeps independent replicas intact', async () => {
  const pool = new ValidationPool(1),
    fixture = await representativeDocument(300, 8);
  const snapshot = Y.encodeStateAsUpdate(fixture.doc),
    first = new IncrementalValidator(pool),
    second = new IncrementalValidator(pool);
  try {
    await first.init(snapshot);
    const updates = Array.from(
      { length: Math.ceil((17 * 1024 ** 2) / snapshot.length) },
      () => snapshot,
    );
    const loaded = await second.init(snapshot, updates);
    assert.equal(loaded.encodedBytes, snapshot.length);
    assert.deepEqual(await second.inspect(), decodeDocument(fixture.doc));
    assert.deepEqual(await first.inspect(), await second.inspect());
    assert.equal(pool.stats[0]!.replicas, 2);
  } finally {
    await first.close();
    await second.close();
    await pool.close();
    fixture.doc.destroy();
  }
});
