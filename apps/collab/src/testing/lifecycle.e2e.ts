import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { readCollabConfig } from '../service/config.ts';
import { collaborationServer } from '../service/server.ts';

test('Failed startup releases listeners and leadership; health follows control loss', async () => {
  const db = await testDatabase();
  const occupied = createServer(),
    portProbe = createServer();
  occupied.listen(0, '127.0.0.1');
  await once(occupied, 'listening');
  portProbe.listen(0, '127.0.0.1');
  await once(portProbe, 'listening');
  const busy = occupied.address(),
    free = portProbe.address();
  assert(busy && typeof busy !== 'string' && free && typeof free !== 'string');
  await new Promise<void>((resolve) => portProbe.close(() => resolve()));
  const config = readCollabConfig({
    ...process.env,
    DATABASE_URL: db.url,
    COLLAB_PORT: String(free.port),
    COLLAB_INTERNAL_PORT: String(busy.port),
  });
  const authorize = async () => {
    throw new Error('No authentication in lifecycle test');
  };
  let host: Awaited<ReturnType<typeof collaborationServer>> | undefined;
  try {
    await assert.rejects(collaborationServer(config, db.pool, authorize), { code: 'EADDRINUSE' });
    host = await collaborationServer({ ...config, COLLAB_INTERNAL_PORT: 0 }, db.pool, authorize);
    const url = `http://127.0.0.1:${free.port}/api/health/collab`;
    assert.equal((await fetch(url)).status, 200);
    await db.pool.query('SELECT pg_terminate_backend($1)', [host.leadership.fence.pid]);
    let status = 200;
    const deadline = Date.now() + 3000;
    while (status === 200 && Date.now() < deadline) {
      await delay(10);
      status = (await fetch(url)).status;
    }
    assert.equal(status, 503);
  } finally {
    await host?.close();
    await new Promise<void>((resolve) => occupied.close(() => resolve()));
    await db.close();
  }
});
