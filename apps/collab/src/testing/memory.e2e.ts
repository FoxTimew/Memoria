import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { readCollabConfig } from '../service/config.ts';
import { collaborationServer } from '../service/server.ts';
import { replicaReservation, poolReservation } from '../service/memory.ts';
import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { seedPage } from './pool-helpers.ts';
test('Real replicas: budget, inactive-first eviction, idle release and pending projection', async () => {
  const db = await testDatabase();
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_VALIDATION_WORKERS: '1',
      COLLAB_REPLICA_MEMORY_BYTES: String(poolReservation(1) + replicaReservation(0)),
      COLLAB_REPLICA_IDLE_MS: '100',
    }),
    db.pool,
    async () => {
      throw new Error('No HTTP sessions in this test');
    },
  );
  async function open(page: string) {
    const value = (await host.command({
      action: 'open',
      user: db.user,
      session: db.session,
      workspace: db.workspace,
      page,
    })) as { room: string };
    const release = await host.memory.acquire(value.room);
    try {
      await host.hocus.createDocument(value.room, new Request('https://localhost'), randomUUID(), {
        readOnly: false,
        isAuthenticated: true,
      });
      return { release, name: value.room };
    } catch (error) {
      release();
      throw error;
    }
  }
  try {
    const first = await open(db.page),
      second = randomUUID();
    await db.pool.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'a1')", [
      second,
      db.workspace,
    ]);
    await assert.rejects(open(second), { code: 'COLLAB_MEMORY_CAPACITY' });
    assert.equal(host.memory.reservedBytes, replicaReservation(0));
    assert.equal(host.memory.chargedBytes, poolReservation(1) + replicaReservation(0));
    await assert.rejects(host.memory.resize(first.name, 200 * 1024), {
      code: 'COLLAB_MEMORY_CAPACITY',
    });
    assert.equal(host.memory.reservedBytes, replicaReservation(0));
    assert(host.rooms.has(first.name));
    first.release();
    const next = await open(second);
    assert(!host.rooms.has(first.name));
    assert(host.rooms.has(next.name));
    assert.equal(host.memory.reservedBytes, replicaReservation(0));
    const state = (
      await db.pool.query(
        'SELECT projection_due_at FROM collaboration_documents WHERE page_id=$1',
        [second],
      )
    ).rows[0];
    assert(state.projection_due_at);
    next.release();
    const end = Date.now() + 3000;
    while (host.memory.reservedBytes && Date.now() < end) await delay(20);
    assert.equal(host.memory.reservedBytes, 0);
    assert.equal(host.rooms.size, 0);
    // Aborted handshakes release their reservation even before the worker starts.
    const release = await host.memory.acquire(next.name);
    release();
    assert.equal(host.memory.reservedBytes, 0);
  } finally {
    await host.close();
    await db.close();
  }
});

test('Growth is reserved before validation/journal, and a capacity rejection leaves SQL and live content unchanged', async () => {
  const db = await testDatabase(),
    fixture = await representativeDocument(300, 1);
  const page = await seedPage(db, Y.encodeStateAsUpdate(fixture.doc));
  fixture.doc.destroy();
  const initial = replicaReservation(page.bytes);
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_VALIDATION_WORKERS: '1',
      COLLAB_REPLICA_MEMORY_BYTES: String(poolReservation(1) + initial),
    }),
    db.pool,
    async () => {
      throw new Error('No HTTP session');
    },
  );
  let release = () => {};
  const client = new Y.Doc();
  client.getXmlFragment('prosemirror');
  try {
    release = await host.memory.acquire(page.name);
    await host.hocus.createDocument(page.name, new Request('https://localhost'), randomUUID(), {
      isAuthenticated: true,
      readOnly: false,
    });
    const room = host.rooms.get(page.name)!;
    Y.applyUpdate(client, Y.encodeStateAsUpdate(room.doc));
    let update!: Uint8Array;
    client.on('update', (value: Uint8Array) => {
      update = value;
    });
    const texts = [...client.getXmlFragment('prosemirror').createTreeWalker(() => true)].filter(
      (n): n is Y.XmlText => n instanceof Y.XmlText,
    );
    client.transact(() => {
      for (const text of texts.slice(0, 50)) text.insert(0, 'x'.repeat(2000));
    });
    assert(replicaReservation(page.bytes + update.length) > initial);
    const live = Y.encodeStateAsUpdate(room.doc);
    await assert.rejects(room.update({ ...db, page: page.page, key: randomUUID() }, update), {
      code: 'COLLAB_MEMORY_CAPACITY',
    });
    assert.deepEqual(Y.encodeStateAsUpdate(room.doc), live);
    assert.equal(room.revision, 0);
    assert.equal(room.fatal, false);
    assert.equal(host.memory.reservedBytes, initial);
    assert.equal(
      Number(
        (
          await db.pool.query('SELECT count(*) AS n FROM collaboration_updates WHERE page_id=$1', [
            page.page,
          ])
        ).rows[0].n,
      ),
      0,
    );
    // A subsequent small edit still succeeds; failed growth did not poison the isolated replica.
    const small = new Y.Doc();
    small.getXmlFragment('prosemirror');
    Y.applyUpdate(small, live);
    small.on('update', (value: Uint8Array) => {
      update = value;
    });
    const text = [...small.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
      (n): n is Y.XmlText => n instanceof Y.XmlText,
    )!;
    text.insert(0, 'ok');
    await room.update({ ...db, page: page.page, key: randomUUID() }, update);
    small.destroy();
    assert.equal(room.revision, 1);
  } finally {
    release();
    client.destroy();
    await host.close();
    await db.close();
  }
});
