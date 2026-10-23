import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { WebSocket } from 'ws';
import { OutgoingMessage } from '@hocuspocus/server';
import { createIngress } from '../service/ingress.ts';
import { readCollabConfig } from '../service/config.ts';
await test('Real WebSocket ingress charges native-queue frames before delivery', async () => {
  const config = readCollabConfig({
    APP_ORIGIN: 'https://localhost',
    DATABASE_URL: 'postgres://localhost/test',
    BETTER_AUTH_SECRET: 'x'.repeat(32),
    COLLAB_INTERNAL_SECRET: 'y'.repeat(32),
    COLLAB_PORT: '0',
    COLLAB_ROOM_QUEUE_MESSAGES: '2',
    COLLAB_MAX_USER_SOCKETS: '1',
  });
  let delivered = 0;
  const ingress = await createIngress(
    config,
    async () => ({ user: 'verified', session: 'session', name: 'Test' }),
    (_ws, _id, _request, budget) => {
      budget.ready = true;
      return () => {
        delivered++;
      };
    },
  );
  try {
    const socket = new WebSocket(ingress.url, { headers: { origin: config.APP_ORIGIN } });
    await once(socket, 'open');
    const excess = new WebSocket(ingress.url, { headers: { origin: config.APP_ORIGIN } });
    await once(excess, 'error');
    assert.equal(ingress.admission.sockets, 1);
    const room = `${randomUUID()}:${randomUUID()}:${randomUUID()}`;
    const frame = new OutgoingMessage(room)
      .createSyncMessage()
      .writeUpdate(new Uint8Array([0, 0]))
      .toUint8Array();
    const closed = once(socket, 'close');
    socket.send(frame);
    socket.send(frame);
    socket.send(frame);
    const [code, reason] = await closed;
    assert.equal(code, 1008);
    assert.equal(String(reason), 'ROOM_QUEUE_FULL');
    assert.equal(delivered, 2);
    assert.equal(ingress.admission.pendingBytes, 0);
    const denied = new WebSocket(ingress.url, { headers: { origin: 'https://foreign.test' } });
    await once(denied, 'error');
    assert.equal(delivered, 2);
    console.log(
      'PASS admission: third queued frame never reaches consumer; foreign origin denied; counters released on close',
    );
  } finally {
    await ingress.close();
  }
});
