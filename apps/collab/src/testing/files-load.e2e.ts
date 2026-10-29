import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as Y from 'yjs';
import { FileBoundary } from '@memoria/db';
import { prepareMeasurement, runMeasuredSeries } from '../../../../scripts/measurement-memory.mjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { loadProfile } from './profiles.ts';
import { caddyFixture } from './caddy-fixture.ts';
import { fileLoadClient, serveFileLoadClient } from './file-load-client.ts';
import { decodeDocument } from '../codec.ts';
import { applyCommands } from '../service/commands.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { traceFileLoadControls, setFileLoadStage } from './file-load-controls.ts';

const reports: object[] = [];
const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1]!;
const originalLock = FileBoundary.prototype.lock,
  originalReplace = FileBoundary.prototype.replaceBlocks;
let collecting = false,
  locks: number[] = [],
  registry: number[] = [];
FileBoundary.prototype.lock = async function (...args: Parameters<typeof originalLock>) {
  const start = performance.now();
  try {
    return await originalLock.apply(this, args);
  } finally {
    if (collecting) locks.push(performance.now() - start);
  }
};
FileBoundary.prototype.replaceBlocks = async function (
  ...args: Parameters<typeof originalReplace>
) {
  const start = performance.now();
  try {
    return await originalReplace.apply(this, args);
  } finally {
    if (collecting) registry.push(performance.now() - start);
  }
};
async function measure(profile: string, series: number) {
  const db = await testDatabase(),
    auth = await testAuth(db),
    accounts = [await auth.account('First writer'), await auth.account('Second writer')];
  const fixture = new Y.Doc();
  fixture.getXmlFragment('prosemirror');
  Y.applyUpdate(fixture, await loadProfile(profile));
  for (const id of [0xeffffe00, 0xefffff00, 0xefffff01]) assert(!fixture.store.clients.has(id));
  fixture.clientID = 0xeffffe00;
  const imageIds = decodeDocument(fixture)
    .filter((b) => b.type === 'core.paragraph')
    .slice(0, 2)
    .map((b) => b.id);
  assert.equal(imageIds.length, 2);
  applyCommands(
    fixture,
    imageIds.map((id) => ({
      op: 'update' as const,
      id,
      type: 'core.image',
      schemaVersion: 1,
      content: { fileId: null, alt: '', caption: '', width: 512 },
    })),
  );
  const snapshot = Y.encodeStateAsUpdate(fixture),
    businessBytes = Buffer.byteLength(JSON.stringify(decodeDocument(fixture)));
  fixture.destroy();
  await db.pool.query(
    'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
    [db.page, db.workspace, db.generation, Buffer.from(snapshot), snapshot.length, businessBytes],
  );
  const boundary = new FileBoundary(db.pool),
    files: string[] = [];
  for (const account of accounts) {
    const id = await boundary.reserve(
      { ...db, ...account, key: account.user },
      { bytes: 100, name: 'measure', idempotency: randomUUID() },
    );
    files.push(id);
    await db.pool.query("UPDATE files SET state='ready' WHERE id=$1", [id]);
    await db.pool.query(
      "UPDATE file_upload_intents SET attach_until=now()+interval '1 day',closed_at=now() WHERE file_id=$1",
      [id],
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
  let proxy: Awaited<ReturnType<typeof caddyFixture>> | undefined;
  const peers: Awaited<ReturnType<typeof fileLoadClient>>[] = [];
  try {
    proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
    const name = `${db.workspace}:${db.page}:${db.generation}`;
    for (const [index, account] of accounts.entries()) {
      peers.push(
        await fileLoadClient(import.meta.filename, {
          url: proxy.url,
          name,
          cookie: account.cookie,
          origin: auth.origin,
          ca: proxy.ca,
          index,
          imageId: imageIds[index]!,
          fileId: files[index]!,
        }),
      );
    }
    assert.equal(new Set(peers.map((p) => p.pid)).size, 2);
    const room = host.rooms.get(name)!;
    let validationStart = 0,
      totals: number[] = [],
      transactions: number[] = [],
      contributions: number[] = [];
    let batchSize = 0;
    const prepare = room.replica.prepareMany.bind(room.replica),
      append = host.store.append.bind(host.store);
    room.replica.prepareMany = async (...args) => {
      validationStart = performance.now();
      batchSize = args[0].length;
      return prepare(...args);
    };
    host.store.append = async (...args) => {
      const start = performance.now();
      const result = await append(...args);
      if (collecting) {
        transactions.push(performance.now() - start);
        totals.push(performance.now() - validationStart);
        contributions.push(batchSize);
      }
      return result;
    };
    // The parent performs synchronous OS probes. Never block the server's heartbeat with them.
    const start = once(process, 'message');
    process.send?.({ kind: 'prepared' });
    const [message] = await start;
    if (message?.kind !== 'start') return;
    for (const references of [false, true])
      for (const authors of [1, 2]) {
        const result = await (async () => {
          locks = [];
          registry = [];
          totals = [];
          transactions = [];
          contributions = [];
          const wire: number[] = [],
            edits: number[] = [],
            receipts = new Set<string>();
          for (let wave = 0; wave < 110; wave++) {
            setFileLoadStage(
              `${profile}:${series}:references=${references}:authors=${authors}:wave=${wave}`,
            );
            collecting = wave >= 10;
            const confirmed = await Promise.all(
              peers.slice(0, authors).map((peer) => peer.edit({ wave, references })),
            );
            if (collecting)
              for (const r of confirmed) {
                assert(!receipts.has(r.receipt), 'Receipt reused between distinct edits');
                receipts.add(r.receipt);
                wire.push(r.wireMs);
                edits.push(r.editMs);
              }
            await delay(100); // Realistic typing; preserve the production per-account wire quota.
          }
          collecting = false;
          await Promise.all(peers.map((peer) => peer.check()));
          assert.equal(wire.length, authors * 100);
          assert.equal(
            contributions.reduce((sum, n) => sum + n, 0),
            authors * 100,
          );
          assert.equal(contributions.length, totals.length);
          const count = Number(
            (await db.pool.query('SELECT count(*) n FROM file_usages WHERE page_id=$1', [db.page]))
              .rows[0].n,
          );
          assert.equal(count, 0);
          return {
            profile,
            series,
            references,
            authors,
            encodedBytes: snapshot.length,
            businessBytes,
            snapshotSha256: createHash('sha256').update(snapshot).digest('hex'),
            serverPid: process.pid,
            clientPids: peers.map((peer) => peer.pid),
            wire,
            edits,
            totals,
            transactions,
            contributions,
            locks,
            registry,
            p95: {
              server: p95(totals),
              wire: p95(wire),
              transaction: p95(transactions),
              locks: locks.length ? p95(locks) : 0,
              registry: registry.length ? p95(registry) : 0,
            },
          };
        })().catch((error: Error) => {
          process.send?.({
            kind: 'result',
            result: {
              profile,
              series,
              references,
              authors,
              partial: true,
              error: error.message,
              totals,
              transactions,
              contributions,
              locks,
              registry,
            },
          });
          throw error;
        });
        process.send?.({ kind: 'result', result });
        console.log(JSON.stringify({ profile, series, references, authors, p95: result.p95 }));
        assert(
          profile === 'history-1M' ? result.p95.server <= 100 : result.p95.server < 50,
          `STOP ${profile} server ${result.p95.server}`,
        );
      }
  } finally {
    collecting = false;
    setFileLoadStage('cleanup');
    await Promise.allSettled(peers.map((p) => p.close()));
    proxy?.close();
    await host.close();
    await auth.pool.end();
    await db.close();
  }
}
if (process.env.MEMORIA_FILES_CLIENT === 'true') {
  serveFileLoadClient();
} else if (process.env.MEMORIA_FILES_PROFILE) {
  try {
    traceFileLoadControls();
    await measure(process.env.MEMORIA_FILES_PROFILE, Number(process.env.MEMORIA_FILES_SERIES));
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    FileBoundary.prototype.lock = originalLock;
    FileBoundary.prototype.replaceBlocks = originalReplace;
    process.disconnect?.();
  }
} else {
  for (const profile of ['content-1M', 'history-1M'])
    for (let series = 1; series <= 3; series++) {
      const label = `files-${profile.toLowerCase()}-${series}`,
        preparation = await prepareMeasurement(label);
      const child = fork(import.meta.filename, [], {
        env: {
          ...process.env,
          MEMORIA_FILES_PROFILE: profile,
          MEMORIA_FILES_SERIES: String(series),
        },
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      const results: object[] = [];
      let closed = false;
      const ended = once(child, 'exit').then(([code]) => {
        closed = true;
        return code as number;
      });
      const prepared = new Promise<void>((resolve, reject) => {
        child.on('message', (message: { kind: string; result?: object }) => {
          if (message.kind === 'prepared') resolve();
          if (message.kind === 'result') results.push(message.result!);
        });
        child.once('error', reject);
        child.once('exit', () => reject(new Error('Fixture exited before preparation')));
      });
      try {
        await prepared;
        const { result, hygiene } = await runMeasuredSeries(
          label,
          async () => {
            child.send({ kind: 'start' });
            const code = await ended;
            return { code, results };
          },
          { preparation, maxAttempts: 1 },
        );
        reports.push({ profile, series, code: result.code, hygiene, results });
        await writeFile(
          '.local/session-7-files-measurement.json',
          JSON.stringify(
            {
              date: new Date().toISOString(),
              scope:
                'Real WSS/Caddy, two separate client processes, no CPU profiler, parent-only OS probes. Server validation-to-SQL-commit timer per merged batch; client-local WSS timer, IPC excluded. Lock timing includes queries, not pure contention. 10 warmups + 100 waves per scenario, 100ms pause after each confirmed wave (at most 10 waves/second).',
              reports,
            },
            null,
            2,
          ) + '\n',
        );
        assert.equal(await ended, 0, 'Measurement child failed: retain partial report and stop');
      } finally {
        if (!closed) {
          child.send({ kind: 'cancel' });
          const timeout = setTimeout(() => child.kill(), 15000);
          await ended;
          clearTimeout(timeout);
        }
      }
    }
}
