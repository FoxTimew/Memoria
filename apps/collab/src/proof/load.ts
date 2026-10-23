import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { proofDatabase } from './database.ts';
import { proofAuth } from './auth.ts';
import { proofServer } from './server.ts';
import { distribution, updateReceipt } from './metrics.ts';
import { decodeDocument } from '../codec.ts';

async function until(predicate: () => boolean, label: string, timeout = 60000) {
  const limit = performance.now() + timeout;
  while (!predicate()) {
    if (performance.now() > limit) throw new Error(`Timed out: ${label}`);
    await delay(20);
  }
}
async function run(batching: boolean) {
  const db = await proofDatabase(),
    authentication = await proofAuth(db),
    fixture = await representativeDocument();
  const generation = randomUUID(),
    room = `${db.workspace}:${db.page}:${generation}`,
    snapshot = Y.encodeStateAsUpdate(fixture.doc);
  await db.client.query(
    'INSERT INTO collaboration_documents(page_id,generation,snapshot) VALUES($1,$2,$3)',
    [db.page, generation, Buffer.from(snapshot)],
  );
  const host = await proofServer(db, authentication, room, snapshot, { measure: true, batching });
  const samples: {
    client: number;
    receipt: string;
    sent: number;
    latency: number;
    revision: number;
  }[] = [];
  const pending = new Map<string, { client: number; sent: number }>();
  const peers: {
    doc: Y.Doc;
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
    target: Y.XmlText | undefined;
  }[] = [];
  const lateness: number[] = [];
  let measuring = false,
    failed = '';
  try {
    for (let i = 0; i < 10; i++) {
      const account = await authentication.account(`Writer ${i}`);
      const doc = new Y.Doc();
      doc.on('update', (update: Uint8Array, origin: unknown) => {
        if (origin === 'typing' && measuring)
          pending.set(updateReceipt(update), { client: i, sent: performance.now() });
      });
      const socket = new HocuspocusProviderWebsocket({
        url: `${host.server.webSocketURL}/collab`,
        autoConnect: false,
        maxAttempts: 1,
        WebSocketPolyfill: class extends WebSocket {
          constructor(url: string) {
            super(url, { headers: { cookie: account.cookie, origin: authentication.origin } });
          }
        },
      });
      const provider = new HocuspocusProvider({
        name: room,
        document: doc,
        websocketProvider: socket,
        awareness: null,
        token: '',
        onStateless: ({ payload }) => {
          const ack = JSON.parse(payload) as { receipt: string; revision: number };
          const sent = pending.get(ack.receipt);
          if (sent) {
            samples.push({
              ...sent,
              receipt: ack.receipt,
              revision: ack.revision,
              latency: performance.now() - sent.sent,
            });
            pending.delete(ack.receipt);
          }
        },
        onAuthenticationFailed: () => {
          failed = 'authentication';
          socket.disconnect();
        },
        onClose: () => {
          if (measuring) failed = 'socket closed';
          socket.disconnect();
        },
      });
      const peer = { doc, provider, socket, target: undefined as Y.XmlText | undefined };
      peers.push(peer);
      provider.attach();
      void socket.connect();
    }
    await until(() => peers.every((p) => p.provider.synced), '10 synced writers');
    for (let i = 0; i < 10; i++)
      peers[i]!.target = [
        ...peers[i]!.doc.getXmlFragment('prosemirror').createTreeWalker(() => true),
      ].filter((n): n is Y.XmlText => n instanceof Y.XmlText)[i];
    // Warm worker and room with sequential real writes before the open-loop workload.
    measuring = true;
    for (let i = 0; i < 20; i++) {
      const peer = peers[i % 10]!;
      peer.doc.transact(() => peer.target!.insert(0, 'w'), 'typing');
      await until(() => pending.size === 0, 'warmup receipt');
    }
    samples.length = 0;
    host.metrics.start();
    const started = performance.now();
    console.log(
      'LOAD: 10 writers, 5 edits/s each, 60 edits/client, open loop; no waiting for confirmations',
    );
    const progress = setInterval(
      () =>
        console.log(
          `LOAD: ${samples.length} confirmed, ${pending.size} client-pending, ${host.metrics.pending.size} received/unconfirmed`,
        ),
      2000,
    );
    try {
      await Promise.all(
        peers.map(async (peer, client) => {
          let due = started + client * 17;
          for (let n = 0; n < 60; n++) {
            await delay(Math.max(0, due - performance.now()));
            lateness.push(Math.max(0, performance.now() - due));
            peer.doc.transact(() => peer.target!.insert(0, String(client)), 'typing');
            due += 180 + ((n * 17 + client * 13) % 41);
          }
        }),
      );
      const typingEnded = performance.now(),
        pendingAtTypingEnd = pending.size;
      await until(() => pending.size === 0 || !!failed, 'all durable receipts');
      assert.equal(failed, '');
      assert.equal(samples.length, 600);
      await until(() => host.metrics.pending.size === 0, 'server queue drained');
      const completed = performance.now();
      await until(
        () =>
          peers.every(
            (p) =>
              JSON.stringify(decodeDocument(p.doc)) ===
              JSON.stringify(decodeDocument(peers[0]!.doc)),
          ),
        'convergence',
      );
      const counts = (
        await db.client.query(
          'SELECT (SELECT count(*) FROM collaboration_updates) AS journal_rows,(SELECT count(*) FROM collaboration_receipts) AS receipts',
        )
      ).rows[0];
      const durable = new Map(
        (
          await db.client.query<{ receipt: string; revision: string }>(
            'SELECT receipt,revision FROM collaboration_receipts',
          )
        ).rows.map((r) => [r.receipt, Number(r.revision)]),
      );
      for (const sample of samples) assert.equal(durable.get(sample.receipt), sample.revision);
      assert.equal(Number(counts.receipts), 620);
      if (batching)
        assert(Number(counts.journal_rows) < 620, 'pending updates must actually batch');
      const transitions = host.metrics.transitions;
      const queueSeconds = [];
      for (let ms = 1000; ms <= completed - started; ms += 1000) {
        const state = transitions.findLast((s) => s.at <= ms)!;
        queueSeconds.push({
          second: ms / 1000,
          outstanding: state.outstanding,
          waiting: state.waiting,
          active: state.active,
        });
      }
      const report = {
        date: new Date().toISOString(),
        batching,
        batchSizes: host.batchSizes,
        writers: 10,
        editsPerWriter: 60,
        targetEditsPerSecond: 50,
        initialYjsBytes: snapshot.length,
        blocks: 300,
        warmup: 20,
        offered: 600,
        confirmed: samples.length,
        pendingAtTypingEnd,
        typingMs: typingEnded - started,
        drainMs: completed - typingEnded,
        totalMs: completed - started,
        latencyMs: distribution(samples.map((s) => s.latency)),
        schedulerLatenessMs: distribution(lateness),
        queue: {
          scope:
            'all ordinary updates received on raw WebSocket until durable acknowledgement, including Hocuspocus per-connection queues',
          maxOutstanding: Math.max(...transitions.map((s) => s.outstanding)),
          maxWaiting: Math.max(...transitions.map((s) => s.waiting)),
          seconds: queueSeconds,
        },
        counts,
        samples: samples.map((s) => ({ ...s, sent: s.sent - started })),
        queueTransitions: transitions,
      };
      await writeFile(
        `.local/session-3-2bis-load-${batching ? 'batched' : 'baseline'}.json`,
        JSON.stringify(report, null, 2),
      );
      console.log(
        JSON.stringify(
          {
            ...report,
            samples: '600 raw samples in report',
            queueTransitions: `${transitions.length} transitions in report`,
          },
          null,
          2,
        ),
      );
      console.log('LOAD MEASUREMENT COMPLETE: all receipts verified and 10 documents converged.');
    } finally {
      clearInterval(progress);
    }
  } finally {
    measuring = false;
    for (const p of peers) {
      p.provider.destroy();
      p.socket.destroy();
      p.doc.destroy();
    }
    await host.close();
    await authentication.pool.end();
    fixture.doc.destroy();
    await db.close();
  }
}
for (const batching of process.argv.includes('--baseline')
  ? [false]
  : process.argv.includes('--batched')
    ? [true]
    : [false, true])
  await run(batching);
