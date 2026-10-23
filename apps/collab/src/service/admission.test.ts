import { it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { OutgoingMessage } from '@hocuspocus/server';
import { Admission } from './admission.ts';
import { readCollabConfig } from './config.ts';
const config = () =>
  readCollabConfig({
    APP_ORIGIN: 'https://localhost',
    DATABASE_URL: 'postgres://localhost/x',
    BETTER_AUTH_SECRET: 'a'.repeat(32),
    COLLAB_INTERNAL_SECRET: 'b'.repeat(32),
    COLLAB_UPDATE_BURST: '2',
    COLLAB_MAX_UNAUTHENTICATED: '1',
    COLLAB_MAX_SOCKETS: '2',
    COLLAB_MAX_USER_SOCKETS: '1',
  });
const room = () => `${randomUUID()}:${randomUUID()}:${randomUUID()}`;
const update = (name: string) =>
  new OutgoingMessage(name)
    .createSyncMessage()
    .writeUpdate(new Uint8Array([0, 0]))
    .toUint8Array();
it('bounds global/per-user sockets, pre-authentication slots, shared user rate and releases counters', () => {
  let now = 0;
  const gate = new Admission(config(), () => now),
    end = gate.beginAuthentication();
  expect(() => gate.beginAuthentication()).toThrow('AUTH_CAPACITY');
  end();
  end();
  gate.beginAuthentication()();
  const a = gate.open('a'),
    b = gate.open('b');
  a.ready = b.ready = true;
  expect(() => gate.open('a')).toThrow('SOCKET_CAPACITY');
  expect(() => gate.open('c')).toThrow('SOCKET_CAPACITY');
  const r = room();
  for (let i = 0; i < 2; i++) {
    const bytes = update(r);
    gate.receive(a, bytes);
    gate.finish(a, bytes);
  }
  expect(() => gate.receive(a, update(r))).toThrow('RATE_LIMIT');
  gate.close(a);
  const next = gate.open('a');
  next.ready = true;
  expect(() => gate.receive(next, update(r))).toThrow('RATE_LIMIT');
  now = 1000;
  const bytes = update(r);
  gate.receive(next, bytes);
  expect(gate.pendingBytes).toBe(bytes.length);
  gate.close(next);
  gate.close(b);
  expect(gate.pendingBytes).toBe(0);
  expect(gate.sockets).toBe(0);
});
it('refuses multiplexing and excessive binary payload before native queues', () => {
  const gate = new Admission({ ...config(), COLLAB_UPDATE_BURST: 10 });
  const a = gate.open('a');
  a.ready = true;
  gate.receive(a, update(room()));
  expect(() => gate.receive(a, update(room()))).toThrow('MULTIPLEXING');
  expect(() => gate.receive(a, new Uint8Array(1048576 + 65537))).toThrow('MESSAGE_TOO_LARGE');
  gate.close(a);
});
