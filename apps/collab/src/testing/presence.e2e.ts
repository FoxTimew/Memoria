import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import * as encoding from 'lib0/encoding';
import { removeAwarenessStates } from 'y-protocols/awareness';
import WebSocket from 'ws';
import { presenceUser } from '@memoria/contracts';
import { CollaborationClient } from '../../../web/src/lib/collaboration-client.ts';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';

async function until(check: () => boolean, label: string) {
  const deadline = Date.now() + 10000;
  while (!check()) {
    if (Date.now() > deadline) throw new Error('Timeout: ' + label);
    await delay(25);
  }
}
function awarenessFrame(room: string, id: number, state: unknown, count = 1) {
  const payload = encoding.createEncoder();
  encoding.writeVarUint(payload, count);
  for (let i = 0; i < count; i++) {
    encoding.writeVarUint(payload, id + i);
    encoding.writeVarUint(payload, 1000000);
    encoding.writeVarString(payload, JSON.stringify(state));
  }
  const wire = encoding.createEncoder();
  encoding.writeVarString(wire, room);
  encoding.writeVarUint(wire, 1);
  encoding.writeVarUint8Array(wire, encoding.toUint8Array(payload));
  return encoding.toUint8Array(wire);
}
test(
  'Real presence: verified names/colors, cursor bounds, no impersonation, no persistence and revoke cleanup',
  { timeout: 30000 },
  async () => {
    const db = await testDatabase(),
      auth = await testAuth(db);
    const alice = await auth.account('Alice Presence'),
      bob = await auth.account('Bob Presence'),
      mallory = await auth.account('Mallory Presence');
    const server = await collaborationServer(
      readCollabConfig({
        ...process.env,
        DATABASE_URL: db.url,
        COLLAB_PORT: '0',
        COLLAB_INTERNAL_PORT: '0',
      }),
      db.pool,
      sessionVerifier(auth.auth),
    );
    const peers: CollaborationClient[] = [];
    try {
      const opened = await server.command({
        action: 'open',
        user: db.user,
        session: db.session,
        workspace: db.workspace,
        page: db.page,
      });
      assert('room' in opened && opened.room);
      const room = opened.room;
      const create = async (account: typeof alice, expected = account) => {
        const peer = new CollaborationClient(
          room,
          opened.generation,
          {
            url: server.ingress.url,
            WebSocketPolyfill: class extends WebSocket {
              constructor(url: string) {
                super(url, { headers: { cookie: account.cookie, origin: auth.origin } });
              }
            },
          },
          undefined,
          presenceUser(expected.user, expected.name),
          expected.session,
        );
        peers.push(peer);
        peer.connect();
        await until(
          () => peer.state.phase === (account === expected ? 'saved' : 'blocked'),
          'initial authentication',
        );
        return peer;
      };
      const a = await create(alice),
        b = await create(bob);
      const wrongCookie = await create(bob, alice);
      assert.equal(
        wrongCookie.state.loaded,
        false,
        'mismatched cached identity cannot receive or send the document',
      );
      await until(() => b.state.people.length === 2, 'two visible users');
      assert.deepEqual(
        b.state.people.find((p) => p.id === alice.user),
        presenceUser(alice.user, alice.name),
      );
      a.provider.awareness!.setLocalStateField('user', {
        id: bob.user,
        name: 'Forged admin',
        color: 'url(javascript:bad)',
      });
      await delay(200);
      assert.equal(b.state.people.find((p) => p.id === alice.user)?.name, alice.name);
      assert.equal(
        b.state.people.some((p) => p.name === 'Forged admin'),
        false,
      );
      a.socket.disconnect();
      await until(() => b.state.people.length === 1, 'presence removed on disconnect');
      a.connect();
      await until(() => b.state.people.length === 2, 'same client reconnect');
      assert.equal(
        b.state.people.find((p) => p.id === alice.user)?.color,
        presenceUser(alice.user, alice.name).color,
      );
      const before = (
        await db.pool.query(
          'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
          [db.page],
        )
      ).rows[0].content_revision;
      const attacker = await create(mallory);
      attacker.socket.send(awarenessFrame(room, a.doc.clientID, null));
      await until(() => attacker.state.phase === 'blocked', 'foreign removal refused');
      assert(b.state.people.some((p) => p.id === alice.user));
      assert.equal(a.state.phase, 'saved');
      assert.equal(b.state.phase, 'saved');
      removeAwarenessStates(b.provider.awareness!, [a.doc.clientID], 'timeout');
      await delay(200);
      assert.equal(
        b.state.phase,
        'saved',
        'local timeout of a remote cursor must not send a foreign removal',
      );
      const malformed = await create(mallory);
      malformed.provider.awareness!.setLocalStateField('cursor', {
        anchor: { item: { client: -1, clock: 0 } },
        head: {},
      });
      await until(() => malformed.state.phase === 'blocked', 'invalid cursor refused');
      const large = await create(mallory);
      large.socket.send(
        awarenessFrame(room, large.doc.clientID, { user: { name: 'x'.repeat(1025) } }),
      );
      await until(() => large.state.phase === 'blocked', 'oversize presence refused at ingress');
      const many = await create(mallory);
      many.socket.send(awarenessFrame(room, many.doc.clientID, {}, 2));
      await until(() => many.state.phase === 'blocked', 'multiple identities refused at ingress');
      const flood = await create(mallory);
      for (let i = 0; i < 25; i++) flood.socket.send(awarenessFrame(room, flood.doc.clientID, {}));
      await until(() => flood.state.phase === 'blocked', 'presence flood refused at ingress');
      assert.equal(b.state.phase, 'saved');
      assert.equal(
        (
          await db.pool.query(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
            [db.page],
          )
        ).rows[0].content_revision,
        before,
      );
      await db.pool.query('DELETE FROM auth_sessions WHERE id=$1', [alice.session]);
      await until(() => a.state.phase === 'blocked', 'revocation closes socket');
      await until(
        () => !b.state.people.some((p) => p.id === alice.user),
        'revocation removes cursor/name',
      );
      assert.equal(b.state.phase, 'saved');
      console.log(
        'PASS real awareness identity, HTTP/WS session binding, stable color, reconnect, foreign removal, remote timeout, cursor validation, byte/client/rate bounds, no journal revision and revoked presence',
      );
    } finally {
      for (const peer of peers) peer.destroy();
      await server.close();
      await auth.pool.end();
      await db.close();
    }
  },
);
