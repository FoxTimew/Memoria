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
import { ProofProjector } from './projection.ts';
import { appendUpdate } from '../journal.ts';

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
const host = await proofServer(db, authentication, room, Y.encodeStateAsUpdate(fixture.doc));
const projector = new ProofProjector(authentication.pool, db.workspace, db.page);
host.setOnCommitted(() => projector.changed());
interface Peer {
  doc: Y.Doc;
  provider: HocuspocusProvider;
  socket: HocuspocusProviderWebsocket;
  received: { status: string; revision: number; receipt: string }[];
  readonly failed: boolean;
  readonly closed: boolean;
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
    closed = false;
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
      socket.disconnect();
    },
  });
  const value = {
    doc,
    provider,
    socket,
    received,
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
let checks = 0;
const passed = (message: string) => {
  checks++;
  console.log(`PASS ${checks}: ${message}`);
};
try {
  const alice = await authentication.account('Alice');
  const bob = await authentication.account('Bob');
  const a = peer(alice.cookie),
    b = peer(bob.cookie);
  await until(() => a.provider.synced && b.provider.synced, 'two authenticated providers');
  assert(matches(a.doc, b.doc));
  passed('Better Auth cookie sessions, two real Hocuspocus providers, nested document loaded');

  const thirdAccount = await authentication.account('Batch author');
  const third = peer(thirdAccount.cookie);
  await until(() => third.provider.synced, 'third batch writer');

  let unblock!: () => void;
  const barrier = new Promise<void>((resolve) => {
    unblock = resolve;
  });
  host.holdNextUpdate(() => barrier);
  const before = text(b.doc).toString();
  text(a.doc).insert(0, 'A');
  await delay(50);
  card(b.doc).setAttribute('health', 66 as unknown as string);
  card(third.doc).setAttribute('biography', 'Third author in queued batch');
  await delay(150);
  assert.equal(text(b.doc).toString(), before);
  assert.equal(await revision(), 0);
  assert.equal(a.received.length, 0);
  unblock();
  await until(
    () => a.received.length === 1 && text(b.doc).toString().startsWith('A'),
    'commit before broadcast',
  );
  assert.equal(a.received[0]!.revision, 1);
  await until(
    () => b.received.length === 1 && third.received.length === 1,
    'all queued batch receipts',
  );
  assert.equal(b.received[0]!.revision, third.received[0]!.revision);
  assert.equal(await revision(), 2);
  const contributors = await authentication.pool.query(
    'SELECT count(*) FROM collaboration_receipts WHERE revision=$1',
    [b.received[0]!.revision],
  );
  assert.equal(Number(contributors.rows[0].count), 2);
  third.destroy();
  peers.splice(peers.indexOf(third), 1);
  await until(() => host.connections.size === 2, 'third writer closed');
  passed(
    'No broadcast/receipt during held commit; pending updates merge into one durable revision with separate receipts/authors',
  );

  card(a.doc).setAttribute('displayName', 'A shared name');
  card(b.doc).setAttribute('biography', 'B shared biography');
  text(a.doc).insert(0, 'left');
  text(b.doc).insert(0, 'right');
  await until(
    () => matches(a.doc, b.doc) && a.received.length + b.received.length >= 3,
    'concurrent edits',
  );
  assert.equal(card(a.doc).getAttribute('displayName'), 'A shared name');
  assert.equal(card(a.doc).getAttribute('biography'), 'B shared biography');
  card(a.doc).setAttribute('health', 75 as unknown as string);
  card(b.doc).setAttribute('health', 25 as unknown as string);
  await until(
    () => card(a.doc).getAttribute('health') === card(b.doc).getAttribute('health'),
    'same field convergence',
  );
  passed('Concurrent text and independent character fields preserved; same field converges');

  a.socket.disconnect();
  await until(() => host.connections.size === 1, 'offline socket closed');
  text(a.doc).insert(0, 'offline');
  text(b.doc).delete(0, 2);
  await until(() => b.received.length >= 2, 'online deletion receipt');
  await a.socket.connect();
  await until(() => a.provider.synced && matches(a.doc, b.doc), 'offline merge');
  const reload = new Y.Doc();
  reload.getXmlFragment('prosemirror');
  Y.applyUpdate(reload, Y.encodeStateAsUpdate(fixture.doc));
  for (const row of (
    await authentication.pool.query<{ update: Buffer }>(
      'SELECT update FROM collaboration_updates ORDER BY revision',
    )
  ).rows)
    Y.applyUpdate(reload, row.update);
  await until(() => matches(a.doc, reload), 'durable replay including deletions');
  reload.destroy();
  passed(
    'Offline edits merge after reauthentication; journal replay reproduces deletions and content',
  );

  await projector.flush();
  const projectedBefore = projector.revision;
  const eventsBefore = Number(
    (await authentication.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count,
  );
  projector.fail = true;
  const incidentBefore = projector.incidents;
  const receiptsBefore = a.received.length + b.received.length;
  card(a.doc).setAttribute('displayName', 'Projection A');
  card(b.doc).setAttribute('biography', 'Projection B');
  await until(
    () => a.received.length + b.received.length >= receiptsBefore + 2,
    'two durable authors',
  );
  const ownRevision = await revision();
  let ownWriteReturned = false;
  const ownWrite = until(() => projector.revision >= ownRevision, 'read own projected write').then(
    () => {
      ownWriteReturned = true;
    },
  );
  await projector.flush();
  assert(projector.incidents > incidentBefore);
  assert.equal(projector.revision, projectedBefore);
  assert(!ownWriteReturned);
  assert.equal(
    Number((await authentication.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count),
    eventsBefore,
  );
  text(b.doc).insert(0, 'during projection outage');
  await until(
    async () => (await revision()) > ownRevision,
    'journal writable during projection outage',
  );
  projector.fail = false;
  await ownWrite;
  const projectedBlocks = (
    await authentication.pool.query(
      'SELECT id,parent_id AS "parentId",position,type,schema_version AS "schemaVersion",content FROM blocks WHERE page_id=$1',
      [db.page],
    )
  ).rows;
  const byId = (rows: { id: string }[]) =>
    rows.sort((left, right) => left.id.localeCompare(right.id));
  assert.deepEqual(byId(projectedBlocks), byId(decodeDocument(b.doc)));
  assert.equal(
    Number((await authentication.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count),
    eventsBefore + 1,
  );
  assert.equal(
    Number(
      (
        await authentication.pool.query(
          "SELECT count(*) FROM audit_logs WHERE (metadata->>'contentRevision')::bigint=$1",
          [projector.revision],
        )
      ).rows[0].count,
    ),
    2,
  );
  const search = (
    await authentication.pool.query('SELECT plain_text FROM search_documents WHERE page_id=$1', [
      db.page,
    ])
  ).rows[0].plain_text as string;
  assert(search.includes('Projection A') && search.includes('Projection B'));
  await projector.flush();
  assert.equal(
    Number((await authentication.pool.query('SELECT count(*) FROM outbox_events')).rows[0].count),
    eventsBefore + 1,
  );
  passed(
    'Async projection exact; SQL failure rolls back effects, typing remains durable, retry aggregates two authors/one outbox and unblocks own-revision wait',
  );

  const savedUpdate = (
    await authentication.pool.query<{ update: Buffer; receipt: string; revision: string }>(
      'SELECT update,receipt,revision FROM collaboration_updates WHERE author_id=$1 ORDER BY revision LIMIT 1',
      [alice.user],
    )
  ).rows[0]!;
  const checkpointRevision = await revision();
  const checkpoint = Y.encodeStateAsUpdate(b.doc);
  await db.client.query('BEGIN');
  await db.client.query(
    'UPDATE collaboration_documents SET snapshot=$2,snapshot_revision=$3 WHERE page_id=$1 AND projection_revision=$3',
    [db.page, Buffer.from(checkpoint), checkpointRevision],
  );
  await db.client.query('DELETE FROM collaboration_updates WHERE page_id=$1 AND revision<=$2', [
    db.page,
    checkpointRevision,
  ]);
  await db.client.query('COMMIT');
  const retried = await appendUpdate(
    db.client,
    { ...db, ...alice },
    savedUpdate.receipt,
    savedUpdate.update,
    decodeDocument(a.doc),
  );
  assert.equal(retried, Number(savedUpdate.revision));
  assert.equal(await revision(), checkpointRevision);
  const restored = new Y.Doc();
  Y.applyUpdate(restored, checkpoint);
  assert(matches(restored, b.doc));
  text(a.doc).insert(0, 'after checkpoint');
  await until(() => matches(a.doc, b.doc), 'old client after compaction');
  for (const row of (
    await authentication.pool.query<{ update: Buffer }>(
      'SELECT update FROM collaboration_updates ORDER BY revision',
    )
  ).rows)
    Y.applyUpdate(restored, row.update);
  assert(matches(restored, b.doc));
  restored.destroy();
  passed(
    'Yjs checkpoint preserves client identities; snapshot+journal reload and idempotent receipt survive compaction',
  );

  const missing = peer(''),
    foreign = peer(alice.cookie, 'https://foreign.test'),
    wrong = peer(alice.cookie, authentication.origin, randomUUID());
  await until(() => missing.failed && foreign.failed && wrong.failed, 'authentication refused');
  for (const p of [missing, foreign, wrong])
    assert.equal(p.doc.getXmlFragment('prosemirror').length, 0);
  passed('Absent cookie, foreign origin and foreign room rejected before content');

  const reader = await authentication.account('Reader');
  host.readers.add(reader.user);
  const r = peer(reader.cookie);
  await until(() => r.provider.synced, 'reader sync');
  const readRevision = await revision();
  text(r.doc).insert(0, 'forbidden');
  await until(() => r.closed, 'read-only update rejected');
  assert.equal(await revision(), readRevision);
  const offlineReader = new Y.Doc();
  Y.applyUpdate(offlineReader, Y.encodeStateAsUpdate(b.doc));
  text(offlineReader).insert(0, 'forbidden sync2');
  const r2 = peer(reader.cookie, authentication.origin, room, offlineReader);
  await until(() => r2.closed, 'read-only sync step2 rejected');
  assert.equal(await revision(), readRevision);
  passed('Read-only fixture receives content; Update and reconnect SyncStep2 cannot persist');

  const invalid = peer(bob.cookie);
  await until(() => invalid.provider.synced, 'invalid peer sync');
  const validBefore = await revision();
  card(invalid.doc).setAttribute('health', -1 as unknown as string);
  await until(() => invalid.closed, 'invalid card rejected');
  assert.equal(await revision(), validBefore);
  assert(matches(a.doc, b.doc));
  const broken = peer(bob.cookie);
  await until(() => broken.provider.synced, 'SQL failure peer sync');
  host.failNextJournal();
  text(broken.doc).insert(0, 'not committed');
  await until(() => broken.closed, 'journal failure closed');
  assert.equal(await revision(), validBefore);
  assert(matches(a.doc, b.doc));
  const invalidBatch = peer(bob.cookie),
    validBatch = peer(thirdAccount.cookie);
  await until(
    () => invalidBatch.provider.synced && validBatch.provider.synced,
    'batch rejection peers',
  );
  let releaseBatch!: () => void;
  const batchBarrier = new Promise<void>((resolve) => {
    releaseBatch = resolve;
  });
  host.holdNextUpdate(() => batchBarrier);
  text(a.doc).insert(0, 'accepted barrier');
  await delay(50);
  card(invalidBatch.doc).setAttribute('health', -2 as unknown as string);
  card(validBatch.doc).setAttribute('biography', 'must not leak from rejected batch');
  await until(() => host.pendingBatchCount === 2, 'two pending candidates');
  releaseBatch();
  await until(() => invalidBatch.closed && validBatch.closed, 'whole invalid batch rejected');
  assert.equal(await revision(), validBefore + 1);
  assert.equal(invalidBatch.received.length, 0);
  assert.equal(validBatch.received.length, 0);
  assert(matches(a.doc, b.doc));
  assert.notEqual(card(b.doc).getAttribute('biography'), 'must not leak from rejected batch');
  text(b.doc).insert(0, 'after rejected batch');
  await until(
    async () => (await revision()) === validBefore + 2 && matches(a.doc, b.doc),
    'healthy room continues after rejected batch',
  );
  passed(
    'Invalid data, SQL failure and invalid multi-author batch never leak or receive receipts; healthy room continues',
  );

  const a2 = peer(alice.cookie);
  await until(() => a2.provider.synced, 'second tab');
  const revokedAt = performance.now();
  await authentication.pool.query('DELETE FROM auth_sessions WHERE id=$1', [alice.session]);
  // Deliberately no notification: exercise the 5-second fallback with real SQL revocation.
  await until(() => a.closed && a2.closed, 'revoked session closes both tabs', 5500);
  assert(performance.now() - revokedAt < 5500);
  assert(!b.closed);
  passed('Session revocation closes both tabs through 5-second fallback; other session stays open');

  await authentication.pool.query(
    'DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
    [db.workspace, bob.user],
  );
  await host.recheck();
  await until(() => b.closed, 'membership revoked');
  passed('Membership removal closes its remaining room');

  const r3 = peer(reader.cookie);
  await until(() => r3.provider.synced, 'fresh reader before ancestor archive');
  const parent = randomUUID();
  await authentication.pool.query(
    "INSERT INTO pages(id,workspace_id,position) VALUES ($1,$2,'parent')",
    [parent, db.workspace],
  );
  await authentication.pool.query('UPDATE pages SET parent_id=$2 WHERE id=$1', [db.page, parent]);
  await authentication.pool.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [parent]);
  await host.recheck();
  await until(() => r3.closed, 'archived ancestor closes descendant');
  passed('Archiving an ancestor closes the descendant collaborative room');
  console.log(
    `Transport proof: ${checks} scenarios passed. Presence, browser cache, Caddy and production integration are not exercised here.`,
  );
} finally {
  for (const p of peers) p.destroy();
  await host.close();
  await projector.close();
  fixture.doc.destroy();
  await authentication.pool.end();
  await db.close();
}
