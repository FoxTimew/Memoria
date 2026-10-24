import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { readCollabConfig } from '../service/config.ts';
import { collaborationServer } from '../service/server.ts';
import { replicaReservation } from '../service/memory.ts';
test('Real replicas: budget, inactive-first eviction, idle release and pending projection', async () => {
  const db = await testDatabase();
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_REPLICA_MEMORY_BYTES: String(replicaReservation),
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
    assert.equal(host.memory.reservedBytes, replicaReservation);
    assert(host.rooms.has(first.name));
    first.release();
    const next = await open(second);
    assert(!host.rooms.has(first.name));
    assert(host.rooms.has(next.name));
    assert.equal(host.memory.reservedBytes, replicaReservation);
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
    const release = await host.memory.acquire('cancelled-handshake');
    release();
    assert.equal(host.memory.reservedBytes, 0);
  } finally {
    await host.close();
    await db.close();
  }
});
