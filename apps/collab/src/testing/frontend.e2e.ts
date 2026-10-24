import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { CollaborationClient } from '../../../web/src/lib/collaboration-client.ts';

async function until(predicate: () => boolean | Promise<boolean>, label: string) {
  const end = Date.now() + 10000;
  while (!(await predicate())) {
    if (Date.now() > end) throw new Error('Timeout: ' + label);
    await delay(20);
  }
}
test(
  'Front provider: durable receipts, offline merge, delete-only resync and blocked revocation',
  { timeout: 30000 },
  async () => {
    const db = await testDatabase(),
      authentication = await testAuth(db);
    const alice = await authentication.account('Front Alice'),
      bob = await authentication.account('Front Bob');
    const config = readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
    });
    const server = await collaborationServer(config, db.pool, sessionVerifier(authentication.auth));
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
      for (const account of [alice, bob]) {
        const peer = new CollaborationClient(opened.room, opened.generation, {
          url: server.ingress.url,
          WebSocketPolyfill: class extends WebSocket {
            constructor(url: string) {
              super(url, { headers: { cookie: account.cookie, origin: authentication.origin } });
            }
          },
        });
        peers.push(peer);
        peer.connect();
      }
      const a = peers[0]!,
        b = peers[1]!;
      await until(
        () => peers.every((p) => p.state.loaded && p.state.phase === 'saved'),
        'initial durable sync',
      );
      const paragraph = (p: CollaborationClient) =>
        [...p.doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
          (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'paragraph',
        )!;
      const text = new Y.XmlText();
      text.insert(0, 'Texte');
      paragraph(a).insert(0, [text]);
      assert(a.state.dirty);
      await until(
        () => a.state.phase === 'saved' && paragraph(b).toString().includes('Texte'),
        'persist then broadcast',
      );
      a.socket.disconnect();
      await until(() => a.state.phase === 'offline', 'offline');
      text.insert(text.length, ' hors ligne');
      const other = paragraph(b).get(0) as Y.XmlText;
      other.insert(0, 'Bob ');
      await until(() => b.state.phase === 'saved', 'online writer');
      a.connect();
      await until(
        () => a.state.phase === 'saved' && paragraph(a).toString() === paragraph(b).toString(),
        'reconnect merge',
      );
      assert(paragraph(a).toString().includes('hors ligne'));
      const vector = Y.encodeStateVector(a.doc);
      text.delete(0, text.length);
      assert.deepEqual(Y.encodeStateVector(a.doc), vector);
      await until(() => a.state.phase === 'saved', 'delete receipt');
      a.socket.disconnect();
      await until(() => a.state.phase === 'offline', 'second disconnect');
      a.connect();
      await until(() => a.state.phase === 'saved', 'already durable deletion re-acknowledged');
      await db.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
        db.workspace,
        alice.user,
      ]);
      await until(() => a.state.phase === 'blocked', 'revocation');
      assert.equal(b.state.phase, 'saved');
    } finally {
      for (const peer of peers) peer.destroy();
      await server.close();
      await db.close();
    }
  },
);
