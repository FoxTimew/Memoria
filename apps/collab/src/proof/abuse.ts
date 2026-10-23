import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { proofDatabase } from './database.ts';
import { proofAuth } from './auth.ts';
import { proofServer } from './server.ts';
import { decodeDocument } from '../codec.ts';

async function until(predicate: () => boolean | Promise<boolean>, label: string, timeout = 7000) {
  const limit = performance.now() + timeout;
  while (!(await predicate())) {
    if (performance.now() > limit) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
const db = await proofDatabase();
const authentication = await proofAuth(db);
const fixture = await representativeDocument(18);
const generation = randomUUID(),
  room = `${db.workspace}:${db.page}:${generation}`;
await db.client.query(
  'INSERT INTO collaboration_documents(page_id,generation,snapshot) VALUES ($1,$2,$3)',
  [db.page, generation, Buffer.from(Y.encodeStateAsUpdate(fixture.doc))],
);
const host = await proofServer(db, authentication, room, Y.encodeStateAsUpdate(fixture.doc), {
  incremental: true,
});
interface Peer {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  received: { status: string; revision: number; receipt: string }[];
  readonly failed: boolean;
  readonly closed: boolean;
  readonly closeCount: number;
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
    url: `${host.server.webSocketURL}/collab`,
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
    closed = false,
    closeCount = 0;
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
      received.push(JSON.parse(payload) as (typeof received)[number]);
    },
    onAuthenticationFailed: () => {
      failed = true;
      socket.disconnect();
    },
    onClose: () => {
      closed = true;
      closeCount++;
      socket.disconnect();
    },
  });
  const value = {
    doc,
    provider,
    socket,
    received,
    get closeCount() {
      return closeCount;
    },
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
    (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
  )!;
const revision = async () =>
  Number(
    (
      await authentication.pool.query(
        'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
        [db.page],
      )
    ).rows[0].content_revision,
  );
const matches = (a: Y.Doc, b: Y.Doc) =>
  JSON.stringify(decodeDocument(a)) === JSON.stringify(decodeDocument(b));
try {
  const alice = await authentication.account('Healthy A'),
    bob = await authentication.account('Healthy B'),
    attacker = await authentication.account('Invalid loop');
  const a = peer(alice.cookie),
    b = peer(bob.cookie),
    bad = peer(attacker.cookie);
  await until(
    () => a.provider.synced && b.provider.synced && bad.provider.synced,
    'three authenticated writers',
  );
  let release!: () => void,
    held = false;
  const barrier = new Promise<void>((resolve) => {
    release = resolve;
  });
  host.holdNextUpdate(() => {
    held = true;
    return barrier;
  });
  text(a.doc).insert(0, 'first');
  await until(() => held, 'held valid update');
  card(bad.doc).setAttribute('health', -1 as unknown as string);
  text(b.doc).insert(0, 'surviving contribution');
  await until(() => host.pendingBatchCount === 2, 'mixed batch waiting');
  release();
  await until(
    () => bad.closed && a.received.length === 1 && b.received.length === 1,
    'selective rejection and healthy receipts',
  );
  assert.equal(await revision(), 2);
  assert.equal(bad.received.length, 0);
  assert.equal(a.closeCount + b.closeCount, 0);
  console.log(
    'PASS: rejected merged candidate split; valid contribution committed and only faulty connection closed',
  );
  const write = async (p: Peer) => {
    for (let i = 0; i < 80; i++) {
      text(p.doc).insert(0, 'x');
      await delay(50);
    }
  };
  const typing = Promise.all([write(a), write(b)]);
  let attempts = 1,
    invalidUpdates = 1;
  while (!host.refusalBudget.blocked(attacker.user)) {
    assert(attempts < 5);
    const p = peer(attacker.cookie);
    attempts++;
    await until(() => p.provider.synced, 'reconnecting attacker');
    for (let i = 0; i < 20; i++) {
      card(p.doc).setAttribute('health', (-10 - i) as unknown as string);
      invalidUpdates++;
      await delay(5);
      if (p.closed) break;
    }
    await until(() => p.closed, 'invalid burst closed');
    assert.equal(p.received.length, 0);
    assert.equal(a.closeCount + b.closeCount, 0);
  }
  assert.equal(attempts, 3);
  for (let i = 0; i < 2; i++) {
    const denied = peer(attacker.cookie);
    await until(() => denied.failed, 'refusal budget blocks reconnect');
    assert.equal(denied.doc.getXmlFragment('prosemirror').length, 0);
  }
  await typing;
  await until(
    () => a.received.length === 81 && b.received.length === 81 && matches(a.doc, b.doc),
    'all healthy edits durable and converged',
    15000,
  );
  assert.equal(a.closeCount + b.closeCount, 0);
  assert(!host.refusalBudget.blocked(alice.user));
  assert(!host.refusalBudget.blocked(bob.user));
  assert(Number(card(a.doc).getAttribute('health')) >= 0);
  const rows = await authentication.pool.query(
    'SELECT author_id,count(*)::int AS count FROM collaboration_receipts GROUP BY author_id',
  );
  assert.equal(
    rows.rows.find((r) => r.author_id === attacker.user),
    undefined,
  );
  assert.equal(rows.rows.find((r) => r.author_id === alice.user)?.count, 81);
  assert.equal(rows.rows.find((r) => r.author_id === bob.user)?.count, 81);
  console.log(
    JSON.stringify({
      scenario: 'invalid loop while two healthy writers type',
      attackerConnections: attempts,
      invalidUpdatesSent: invalidUpdates,
      blockedReconnects: 2,
      healthyReceipts: [a.received.length, b.received.length],
      healthyDisconnections: [a.closeCount, b.closeCount],
      sqlReceipts: 162,
      revision: await revision(),
      converged: true,
    }),
  );
  console.log(
    'ABUSE PROOF COMPLETE: valid contributors never disconnected; all 162 healthy updates have durable receipts; attacker throttled across sockets.',
  );
} finally {
  for (const p of peers) p.destroy();
  await host.close();
  fixture.doc.destroy();
  await authentication.pool.end();
  await db.close();
}
