import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { readFile, writeFile } from 'node:fs/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import { prepareMeasurement, runMeasuredSeries } from '../../../../scripts/measurement-memory.mjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { loadProfile } from './profiles.ts';
import { representativeDocument } from './fixture.ts';
import { historyFixture } from './sized-fixture.ts';
import { caddyFixture } from './caddy-fixture.ts';
import { fileLoadClient, serveFileLoadClient } from './file-load-client.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { decodeDocument } from '../codec.ts';
import { receiptFor } from '../service/store.ts';
import { fileServerTrace } from './file-load-trace.ts';
import { traceFileLoadControls, setFileLoadStage } from './file-load-controls.ts';
const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]!;
async function typicalProfile(profile: string) {
  const path = `.local/incremental/mixed-${profile}-typical.bin`;
  try {
    return await readFile(path);
  } catch {
    const doc =
      profile === 'history-1M'
        ? (await historyFixture(170 * 1024)).doc
        : (await representativeDocument(300, 1)).doc;
    if (profile === 'content-1M')
      for (const n of doc.getXmlFragment('prosemirror').createTreeWalker(() => true)) {
        if (!(n instanceof Y.XmlElement) || n.nodeName !== 'gamedevCharacterCard') continue;
        const gap = 170 * 1024 - Y.encodeStateAsUpdate(doc).length - 256;
        if (gap > 0)
          n.setAttribute(
            'biography',
            'x'.repeat(Math.min(4990, gap + String(n.getAttribute('biography')).length)),
          );
      }
    const bytes = Y.encodeStateAsUpdate(doc);
    doc.destroy();
    assert(bytes.length <= 200 * 1024);
    await writeFile(path, bytes);
    return bytes;
  }
}

async function scenario(profile: string, conversions: boolean) {
  const db = await testDatabase(),
    auth = await testAuth(db),
    accounts = [];
  for (let n = 0; n < 10; n++) accounts.push(await auth.account('Mixed writer ' + n));
  const bytes = await loadProfile(profile),
    typical = await typicalProfile(profile);
  const pages: { page: string; generation: string; bytes: number; sha256: string }[] = [];
  for (let n = 0; n < 5; n++) {
    const page = randomUUID(),
      generation = randomUUID();
    let snapshot: Uint8Array = bytes;
    if (n > 0) {
      const doc = new Y.Doc();
      Y.applyUpdate(doc, typical);
      doc.clientID = 0xeffffe10 + n;
      for (const node of doc.getXmlFragment('prosemirror').createTreeWalker(() => true)) {
        if (!(node instanceof Y.XmlElement)) continue;
        const id = node.getAttribute('id');
        if (!id) continue;
        const h = createHash('sha256').update(`${profile}:${n}:${id}`).digest('hex').slice(0, 32);
        node.setAttribute(
          'id',
          `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-8${h.slice(17, 20)}-${h.slice(20)}`,
        );
      }
      snapshot = Y.encodeStateAsUpdate(doc);
      doc.destroy();
      assert(snapshot.length <= 200 * 1024);
    }
    const verified = new Y.Doc();
    Y.applyUpdate(verified, snapshot);
    const actualBusiness = Buffer.byteLength(JSON.stringify(decodeDocument(verified)));
    verified.destroy();
    pages.push({
      page,
      generation,
      bytes: snapshot.length,
      sha256: createHash('sha256').update(snapshot).digest('hex'),
    });
    await db.pool.query('INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,$3)', [
      page,
      db.workspace,
      'a' + (n + 1),
    ]);
    await db.pool.query(
      'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
      [page, db.workspace, generation, Buffer.from(snapshot), snapshot.length, actualBusiness],
    );
  }
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_HOST: '0.0.0.0',
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
    }),
    db.pool,
    sessionVerifier(auth.auth),
  );
  const peers: Awaited<ReturnType<typeof fileLoadClient>>[] = [],
    calibration: { offsetNs: bigint; uncertaintyMs: number }[] = [],
    samples: object[] = [],
    conversionsDone: object[] = [];
  let proxy: Awaited<ReturnType<typeof caddyFixture>> | undefined,
    converter: ReturnType<typeof fork> | undefined,
    converterEnded: Promise<unknown> | undefined,
    conversionError: string | undefined;
  const pageMetrics = pages.map(() => ({ server: [] as number[], transaction: [] as number[] }));
  const totals: number[] = [],
    transactions: number[] = [],
    start = new Map<string, number>();
  let collecting = false,
    published = false;
  try {
    proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
    for (let i = 0; i < 10; i++) {
      const page = pages[Math.floor(i / 2)]!,
        a = accounts[i]!;
      const peer = await fileLoadClient(import.meta.filename, {
        url: proxy.url,
        name: `${db.workspace}:${page.page}:${page.generation}`,
        cookie: a.cookie,
        origin: auth.origin,
        ca: proxy.ca,
        index: i,
        imageId: '',
        fileId: '',
        trace: true,
        observe: true,
      });
      peers.push(peer);
      let best = { offsetNs: 0n, uncertaintyMs: Infinity };
      for (let n = 0; n < 10; n++) {
        const a = process.hrtime.bigint(),
          remote = BigInt(await peer.clock()),
          b = process.hrtime.bigint();
        const uncertaintyMs = Number(b - a) / 2e6;
        if (uncertaintyMs < best.uncertaintyMs)
          best = { offsetNs: (a + b) / 2n - remote, uncertaintyMs };
      }
      calibration.push(best);
    }
    const traces = pages.map((p) =>
      fileServerTrace(host, host.rooms.get(`${db.workspace}:${p.page}:${p.generation}`)!),
    );
    for (const room of host.rooms.values()) {
      const prepare = room.replica.prepareMany.bind(room.replica);
      room.replica.prepareMany = (updates) => {
        for (const u of updates) start.set(receiptFor(u), performance.now());
        return prepare(updates);
      };
    }
    const append = host.store.append.bind(host.store);
    host.store.append = async (...args) => {
      const began = performance.now(),
        r = await append(...args);
      if (collecting) {
        transactions.push(performance.now() - began);
        totals.push(performance.now() - Math.min(...args[2].map((e) => start.get(e.receipt)!)));
        const m = pageMetrics[pages.findIndex((p) => p.page === args[2][0]!.identity.page)]!;
        m.server.push(totals.at(-1)!);
        m.transaction.push(transactions.at(-1)!);
      }
      return r;
    };
    if (conversions) {
      converter = fork(resolve('scripts/file-mixed-converter.mjs'), [], {
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      converterEnded = once(converter, 'exit');
      await new Promise<void>((yes, no) => {
        converter!.on('message', (m: { kind: string; result?: object; error?: string }) => {
          if (m.kind === 'prepared') yes();
          if (m.kind === 'conversion') conversionsDone.push(m.result!);
          if (m.kind === 'failure') {
            conversionError = m.error;
            no(Error(m.error));
          }
        });
        converter!.once('error', no);
        converter!.once('exit', (code) => {
          if (code) {
            conversionError = 'Converter exited ' + code;
            no(Error(conversionError));
          }
        });
      });
    }
    process.send?.({ kind: 'prepared' });
    await once(process, 'message');
    converter?.send({ kind: 'start' });
    for (let wave = 0; wave < 110; wave++) {
      setFileLoadStage(`mixed:${profile}:conversions=${conversions}:wave=${wave}`);
      collecting = wave >= 10;
      if (conversionError) throw Error(conversionError);
      const receipts = await Promise.all(
        peers.map((peer) => peer.edit({ wave, references: false, insertOnly: true })),
      );
      for (let i = 0; i < 10; i++) {
        const r = receipts[i]!,
          other = i ^ 1;
        let observed = await peers[other]!.observe(0xefffff00 + i, r.clock!);
        for (let retry = 0; !observed && retry < 50; retry++) {
          await delay(10);
          observed = await peers[other]!.observe(0xefffff00 + i, r.clock!);
        }
        assert(observed, 'Other writer never applied the update');
        const server = traces[Math.floor(i / 2)]!(r.receipt);
        if (collecting)
          samples.push({
            pageIndex: Math.floor(i / 2),
            ...r,
            ...server,
            remoteAppliedMs:
              Number(
                BigInt(observed) +
                  calibration[other]!.offsetNs -
                  BigInt(r.startedNs!) -
                  calibration[i]!.offsetNs,
              ) / 1e6,
            clockUncertaintyMs: calibration[i]!.uncertaintyMs + calibration[other]!.uncertaintyMs,
          });
      }
      await delay(100);
    }
    collecting = false;
    for (let i = 0; i < 10; i += 2) {
      const a = new Y.Doc(),
        b = new Y.Doc();
      Y.applyUpdate(a, Uint8Array.from(await peers[i]!.snapshot()));
      Y.applyUpdate(b, Uint8Array.from(await peers[i + 1]!.snapshot()));
      assert.deepEqual(decodeDocument(a), decodeDocument(b));
      a.destroy();
      b.destroy();
    }
    converter?.send({ kind: 'stop' });
    if (converterEnded) await converterEnded;
    assert(!conversionError, conversionError);
    if (conversions) assert(conversionsDone.length >= 2, 'Insufficient conversion overlap');
    const values = samples as { pageIndex: number; wireMs: number; remoteAppliedMs: number }[];
    const result = {
      profile,
      conversions,
      encodedBytes: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
      writers: 10,
      pages: 5,
      warmup: 10,
      waves: 100,
      converged: true,
      calibration: calibration.map((c) => ({ ...c, offsetNs: String(c.offsetNs) })),
      samples,
      totals,
      transactions,
      conversionsDone,
      perPage: pages.map((p, i) => ({
        index: i,
        encodedBytes: p.bytes,
        sha256: p.sha256,
        p95: {
          server: p95(pageMetrics[i]!.server),
          transaction: p95(pageMetrics[i]!.transaction),
          wire: p95(values.filter((s) => s.pageIndex === i).map((s) => s.wireMs)),
          otherClient: p95(values.filter((s) => s.pageIndex === i).map((s) => s.remoteAppliedMs)),
        },
      })),
      p95: {
        server: p95(totals),
        transaction: p95(transactions),
        wire: p95(values.map((r) => r.wireMs)),
        otherClient: p95(values.map((r) => r.remoteAppliedMs)),
      },
    };
    process.send?.({ kind: 'result', result });
    published = true;
    console.log(JSON.stringify({ profile, conversions, p95: result.p95 }));
    for (const p of result.perPage) {
      assert(
        p.p95.server < (p.index === 0 && profile === 'history-1M' ? 100 : 50),
        `STOP_MIXED_SERVER_LIMIT page=${p.index} p95=${p.p95.server}`,
      );
      if (p.index > 0 || profile === 'content-1M')
        assert(p.p95.wire < 200, `STOP_MIXED_WSS_LIMIT page=${p.index} p95=${p.p95.wire}`);
    }
  } catch (e) {
    if (!published)
      process.send?.({
        kind: 'result',
        result: {
          profile,
          conversions,
          partial: true,
          error: String(e),
          samples,
          totals,
          transactions,
          conversionsDone,
        },
      });
    throw e;
  } finally {
    collecting = false;
    if (converter?.connected) {
      converter.send({ kind: 'stop' });
      await converterEnded;
    }
    await Promise.allSettled(peers.map((p) => p.close()));
    proxy?.close();
    await host.close();
    await auth.pool.end();
    await db.close();
  }
}

if (process.env.MEMORIA_FILES_CLIENT === 'true') serveFileLoadClient();
else if (process.env.MEMORIA_MIXED_PROFILE) {
  traceFileLoadControls();
  try {
    await scenario(
      process.env.MEMORIA_MIXED_PROFILE,
      process.env.MEMORIA_MIXED_CONVERSIONS === 'true',
    );
  } catch (e) {
    process.send?.({ kind: 'failure', error: String(e) });
    console.error(e);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
} else {
  const reports: object[] = [];
  for (const profile of ['content-1M', 'history-1M'])
    for (let series = 1; series <= 3; series++)
      for (const conversions of [false, true]) {
        const label = `mixed-${profile.toLowerCase()}-${conversions}-${series}`,
          preparation = await prepareMeasurement(label),
          results: object[] = [];
        const child = fork(import.meta.filename, [], {
            windowsHide: true,
            env: {
              ...process.env,
              MEMORIA_MIXED_PROFILE: profile,
              MEMORIA_MIXED_CONVERSIONS: String(conversions),
            },
            stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
          }),
          ended = once(child, 'exit');
        let closed = false;
        void ended.then(() => {
          closed = true;
        });
        try {
          await new Promise<void>((yes, no) => {
            child.on('message', (m: { kind: string; result?: object; error?: string }) => {
              if (m.kind === 'prepared') yes();
              if (m.kind === 'result') results.push(m.result!);
              if (m.kind === 'failure') results.push({ error: m.error });
            });
            child.once('exit', () => no(Error('Mixed fixture exited before ready')));
            child.once('error', no);
          });
          const measured = await runMeasuredSeries(
            label,
            async () => {
              child.send({ kind: 'start' });
              const [code] = await ended;
              return { code, results };
            },
            { preparation, maxAttempts: 1 },
          );
          reports.push({ profile, series, conversions, ...measured });
          await writeFile(
            '.local/session-7-7d-mixed.json',
            JSON.stringify(
              {
                date: new Date().toISOString(),
                scope:
                  '10 real WSS clients in separate processes, 5 pages, actual other-client application; optional permanent 8K converter. No uploads yet: staged mixed-load qualification, stop at first failed ceiling.',
                reports,
              },
              null,
              2,
            ) + '\n',
          );
          assert.equal(measured.result.code, 0, 'STOP_MIXED_KEEP_REPORT');
        } finally {
          if (!closed) {
            child.send({ kind: 'cancel' });
            const timer = setTimeout(() => child.kill(), 40000);
            await ended;
            clearTimeout(timer);
          }
        }
      }
}
