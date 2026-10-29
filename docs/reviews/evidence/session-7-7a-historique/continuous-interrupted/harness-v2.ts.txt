// Diagnostic only: no application change, and no performance qualification with a CPU sampler.
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import { monitorEventLoopDelay, PerformanceObserver } from 'node:perf_hooks';
import { gzipSync } from 'node:zlib';
import type { Worker } from 'node:worker_threads';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import { FileBoundary } from '@memoria/db';
import { prepareMeasurement, runMeasuredSeries } from '../../../../scripts/measurement-memory.mjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { loadProfile } from './profiles.ts';
import { caddyFixture } from './caddy-fixture.ts';
import { securityPeer } from './security-peer.ts';
import { until } from './pool-helpers.ts';
import { decodeDocument } from '../codec.ts';
import { applyCommands } from '../service/commands.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { receiptFor } from '../service/store.ts';
import type { ValidationPool } from '../service/validation-pool.ts';
import { Revocations } from '../service/revocations.ts';

let diagnosticStage = 'fixture';
// Keep the fail-closed behavior intact; identify a control failure instead of guessing its cause.
const revocationStart = Revocations.prototype.start;
Revocations.prototype.start = async function () {
  const control = (this as unknown as { control: import('pg').Client }).control;
  const original = control.query;
  control.query = function (this: import('pg').Client, ...args: unknown[]) {
    const result = Reflect.apply(original, this, args) as Promise<unknown>;
    return result.catch((error: Error & { code?: string }) => {
      console.error(
        JSON.stringify({
          diagnostic: 'control-query-failed',
          stage: diagnosticStage,
          name: error.name,
          code: error.code,
          message: error.message,
        }),
      );
      throw error;
    });
  } as typeof control.query;
  return revocationStart.call(this);
};

const root = resolve(process.env.MEMORIA_HISTORY_OUTPUT!);
assert(
  root.startsWith(resolve('.local/history-profile') + (process.platform === 'win32' ? '\\' : '/')),
);
const p95 = (a: number[]) =>
  a.length ? [...a].sort((a, b) => a - b)[Math.ceil(a.length * 0.95) - 1]! : 0;
const summarize = (a: number[]) => ({
  samples: a.length,
  p95: p95(a),
  max: a.length ? Math.max(...a) : 0,
});
type Mode = 'shared' | 'isolated';
type PeerConfig = {
  url: string;
  name: string;
  cookie: string;
  origin: string;
  ca: string;
  index: number;
};
type EditResult = { wireMs: number; editMs: number; bytes: number };
async function saveCpu(label: string, profile: Profiler.Profile) {
  await writeFile(resolve(root, label + '.cpuprofile.gz'), gzipSync(JSON.stringify(profile)));
  const byId = new Map(profile.nodes.map((n) => [n.id, n])),
    self = new Map<number, number>();
  for (let i = 0; i < (profile.samples?.length ?? 0); i++) {
    const id = profile.samples![i]!;
    self.set(id, (self.get(id) ?? 0) + (profile.timeDeltas?.[i] ?? 0) / 1000);
  }
  return {
    path: label + '.cpuprofile.gz',
    sampledMs: [...self.values()].reduce((a, b) => a + b, 0),
    topSelf: [...self]
      .sort((a, b) => b[1] - a[1])
      .slice(0, 30)
      .map(([id, ms]) => ({ ms, ...byId.get(id)!.callFrame })),
    idleMs: [...self]
      .filter(([id]) => byId.get(id)!.callFrame.functionName === '(idle)')
      .reduce((n, [, v]) => n + v, 0),
  };
}
async function startCpu() {
  const s = new Session();
  s.connect();
  await s.post('Profiler.enable');
  await s.post('Profiler.start');
  return async (label: string) => {
    try {
      return await saveCpu(label, (await s.post('Profiler.stop')).profile);
    } finally {
      s.disconnect();
    }
  };
}
async function localPeer(c: PeerConfig) {
  const peer = securityPeer(c.url, c.name, c.cookie, c.origin, '', c.ca);
  peer.doc.clientID = 0xefffff00 + c.index;
  await until(() => peer.provider.synced || peer.closed, 'profile sync');
  assert(!peer.closed, peer.reason);
  assert.equal(peer.doc.clientID, 0xefffff00 + c.index);
  return {
    async edit(wave: number): Promise<EditResult> {
      assert(!peer.closed, peer.reason);
      const started = performance.now();
      let key = '',
        bytes = 0;
      const received = new Promise<void>((yes, no) => {
        const timer = setTimeout(() => {
          peer.provider.off('stateless', handler);
          no(new Error('PROFILE_RECEIPT_TIMEOUT'));
        }, 5000);
        const handler = ({ payload }: { payload: string }) => {
          const r = JSON.parse(payload);
          if (r.status === 'durable' && r.receipt === key) {
            clearTimeout(timer);
            peer.provider.off('stateless', handler);
            yes();
          }
        };
        peer.provider.on('stateless', handler);
        peer.doc.once('update', (u: Uint8Array) => {
          key = receiptFor(u);
          bytes = u.length;
        });
      });
      const nodes = [...peer.doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
      const text = nodes.filter((n): n is Y.XmlText => n instanceof Y.XmlText)[c.index]!;
      peer.doc.transact(() => {
        if (wave % 2) text.delete(0, 1);
        else text.insert(0, 'x');
      });
      const editMs = performance.now() - started;
      await received;
      return { wireMs: performance.now() - started, editMs, bytes };
    },
    async close() {
      peer.destroy();
    },
  };
}
type LocalPeer = Awaited<ReturnType<typeof localPeer>>;
type RemoteReply = { id: number; result?: unknown; error?: string };
async function remotePeer(config: PeerConfig) {
  const child = fork(import.meta.filename, [], {
    env: { ...process.env, MEMORIA_HISTORY_ROLE: 'client' },
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  let next = 0;
  const pending = new Map<number, { yes: (v: unknown) => void; no: (e: Error) => void }>();
  child.on('message', (m: RemoteReply) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    if (m.error) p.no(new Error(m.error));
    else p.yes(m.result);
  });
  const ended = once(child, 'exit');
  child.once('exit', () => {
    for (const p of pending.values()) p.no(new Error('Client exited'));
    pending.clear();
  });
  const request = (op: string, data: object = {}) =>
    new Promise<unknown>((yes, no) => {
      const id = ++next;
      pending.set(id, { yes, no });
      child.send({ id, op, ...data });
    });
  try {
    await request('init', { config });
  } catch (e) {
    child.kill();
    await ended;
    throw e;
  }
  return {
    edit: async (wave: number) => (await request('edit', { wave })) as EditResult,
    start: () => request('start'),
    stop: (label: string) => request('stop', { label }),
    async close() {
      try {
        await request('close');
      } finally {
        child.disconnect();
        const timer = setTimeout(() => child.kill(), 5000);
        await ended;
        clearTimeout(timer);
      }
    },
  };
}

// Read and wrap the real pool methods in this disposable diagnostic process only.
type Job = { id: number; operation: string };
type Slot = { id: number; worker: Worker; queue: Job[]; active?: Job; failed: boolean };
type Reply = { elapsed: number; result: unknown };
type PoolProbe = {
  nextId: number;
  slots: Set<Slot>;
  dispatch: (slot: Slot) => void;
  enqueue: (
    slot: Slot,
    replica: number,
    op: string,
    data: object,
    deadline: number,
  ) => Promise<Reply>;
};
type PoolSample = {
  worker: number;
  operation: string;
  queueAtEnqueue: number;
  waitMs: number;
  workerMs: number;
  roundTripMs: number;
  outsideWorkerMs: number;
};
function tracePool(pool: ValidationPool, collect: () => boolean, samples: PoolSample[]) {
  const p = pool as unknown as PoolProbe,
    originalDispatch = p.dispatch,
    originalEnqueue = p.enqueue,
    dispatched = new Map<number, number>();
  p.dispatch = function (slot) {
    if (!slot.failed && !slot.active && slot.queue.length)
      dispatched.set(slot.queue[0]!.id, performance.now());
    return originalDispatch.call(this, slot);
  };
  p.enqueue = async function (slot, replica, op, data, deadline) {
    const begin = performance.now(),
      record = collect(),
      queueAtEnqueue = slot.queue.length + (slot.active ? 1 : 0);
    const result = originalEnqueue.call(this, slot, replica, op, data, deadline),
      id = this.nextId;
    try {
      const r = await result,
        end = performance.now(),
        sent = dispatched.get(id);
      if (record && sent !== undefined)
        samples.push({
          worker: slot.id,
          operation: op,
          queueAtEnqueue,
          waitMs: sent - begin,
          workerMs: r.elapsed,
          roundTripMs: end - begin,
          outsideWorkerMs: end - sent - r.elapsed,
        });
      return r;
    } finally {
      dispatched.delete(id);
    }
  };
  return {
    probe: p,
    restore() {
      p.dispatch = originalDispatch;
      p.enqueue = originalEnqueue;
    },
  };
}
async function runServer(mode: Mode, series: number) {
  const db = await testDatabase(),
    auth = await testAuth(db),
    accounts = [await auth.account('First writer'), await auth.account('Second writer')];
  let host: Awaited<ReturnType<typeof collaborationServer>> | undefined,
    proxy: Awaited<ReturnType<typeof caddyFixture>> | undefined;
  const peers: (LocalPeer | Awaited<ReturnType<typeof remotePeer>>)[] = [];
  try {
    const fixture = new Y.Doc();
    fixture.getXmlFragment('prosemirror');
    Y.applyUpdate(fixture, await loadProfile('history-1M'));
    assert(!fixture.store.clients.has(0xeffffe00));
    fixture.clientID = 0xeffffe00;
    const ids = decodeDocument(fixture)
      .filter((b) => b.type === 'core.paragraph')
      .slice(0, 2)
      .map((b) => b.id);
    applyCommands(
      fixture,
      ids.map((id) => ({
        op: 'update' as const,
        id,
        type: 'core.image',
        schemaVersion: 1,
        content: { fileId: null, alt: '', caption: '', width: 512 },
      })),
    );
    const snapshot = Y.encodeStateAsUpdate(fixture),
      businessBytes = Buffer.byteLength(JSON.stringify(decodeDocument(fixture))),
      clientIds = fixture.store.clients.size;
    fixture.destroy();
    await db.pool.query(
      'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
      [db.page, db.workspace, db.generation, Buffer.from(snapshot), snapshot.length, businessBytes],
    );
    // Retain the same two ready intents as the original fixture; no reference is changed.
    const boundary = new FileBoundary(db.pool);
    for (const a of accounts) {
      const id = await boundary.reserve(
        { ...db, ...a, key: a.user },
        { bytes: 100, name: 'profile', idempotency: randomUUID() },
      );
      await db.pool.query("UPDATE files SET state='ready' WHERE id=$1", [id]);
      await db.pool.query(
        "UPDATE file_upload_intents SET attach_until=now()+interval '1 day',closed_at=now() WHERE file_id=$1",
        [id],
      );
    }
    host = await collaborationServer(
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
    proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
    const name = `${db.workspace}:${db.page}:${db.generation}`;
    for (let index = 0; index < 2; index++) {
      const config = {
        url: proxy.url,
        name,
        cookie: accounts[index]!.cookie,
        origin: auth.origin,
        ca: proxy.ca,
        index,
      };
      peers.push(mode === 'shared' ? await localPeer(config) : await remotePeer(config));
    }
    const room = host.rooms.get(name)!;
    let collecting = false;
    const roomIngress: { waiting: number; wallMs: number }[] = [];
    const originalUpdate = room.update.bind(room);
    room.update = async (...args) => {
      const start = performance.now(),
        waiting = room.queue.waiting,
        record = collecting;
      const r = await originalUpdate(...args);
      if (record) roomIngress.push({ waiting, wallMs: performance.now() - start });
      return r;
    };
    const poolSamples: PoolSample[] = [],
      trace = tracePool(host.validators, () => collecting, poolSamples);
    const phases: {
      validationWallMs: number;
      workerMs: number;
      beforeAppendMs: number;
      sqlMs: number;
      serverMs: number;
      contributions: number;
    }[] = [];
    let phase = { started: 0, prepared: 0, worker: 0, n: 0 };
    const prepare = room.replica.prepareMany.bind(room.replica),
      append = host.store.append.bind(host.store);
    room.replica.prepareMany = async (...args) => {
      phase = { started: performance.now(), prepared: 0, worker: 0, n: args[0].length };
      const r = await prepare(...args);
      phase.prepared = performance.now();
      phase.worker = r.validationMs;
      return r;
    };
    host.store.append = async (...args) => {
      const start = performance.now(),
        r = await append(...args),
        end = performance.now();
      if (collecting)
        phases.push({
          validationWallMs: phase.prepared - phase.started,
          workerMs: phase.worker,
          beforeAppendMs: start - phase.prepared,
          sqlMs: end - start,
          serverMs: end - phase.started,
          contributions: phase.n,
        });
      return r;
    };
    const ready = once(process, 'message');
    process.send?.({ kind: 'prepared' });
    const [message] = await ready;
    if (message.kind !== 'start') return;
    const liveSlot = [...trace.probe.slots].find((s) => s.id === room.replica.workerId)!;
    // One continuous capture: no stop/serialization/restart between the two live workloads.
    diagnosticStage = 'start-profilers';
    const stopMain = await startCpu(),
      workerCpu = await liveSlot.worker.startCpuProfile();
    for (const peer of peers) if ('start' in peer) await peer.start();
    let workloadError: unknown;
    try {
      for (const authors of [1, 2]) {
        diagnosticStage = `workload-${authors}`;
        const gc: { at: number; durationMs: number }[] = [];
        const observer = new PerformanceObserver((list) => {
          for (const e of list.getEntries())
            if (collecting) gc.push({ at: e.startTime, durationMs: e.duration });
        });
        observer.observe({ entryTypes: ['gc'] });
        const lag = monitorEventLoopDelay({ resolution: 5 });
        lag.enable();
        const mainCpu = process.threadCpuUsage(),
          poolCpu = await liveSlot.worker.cpuUsage();
        const edits: EditResult[] = [],
          roomWaiting: number[] = [];
        poolSamples.length = 0;
        phases.length = 0;
        roomIngress.length = 0;
        let mainUsage = { user: 0, system: 0 },
          workerUsage = { user: 0, system: 0 };
        try {
          for (let wave = 0; wave < 110; wave++) {
            diagnosticStage = `workload-${authors}-wave-${wave}`;
            collecting = wave >= 10;
            const result = await Promise.all(
              peers.slice(0, authors).map((peer) => peer.edit(wave)),
            );
            if (collecting) {
              edits.push(...result);
              roomWaiting.push(room.queue.waiting);
            }
            await delay(100);
          }
        } finally {
          collecting = false;
          mainUsage = process.threadCpuUsage(mainCpu);
          workerUsage = await liveSlot.worker.cpuUsage(poolCpu);
          observer.disconnect();
          lag.disable();
        }
        const work = poolSamples.filter(
          (p) => p.worker === liveSlot.id && p.operation === 'prepare',
        );
        const summary = {
          mode,
          series,
          authors,
          server: summarize(phases.map((p) => p.serverMs)),
          validationWall: summarize(phases.map((p) => p.validationWallMs)),
          worker: summarize(work.map((p) => p.workerMs)),
          poolWait: summarize(work.map((p) => p.waitMs)),
          ipcAndScheduling: summarize(work.map((p) => p.outsideWorkerMs)),
          sql: summarize(phases.map((p) => p.sqlMs)),
          wire: summarize(edits.map((p) => p.wireMs)),
          clientEdit: summarize(edits.map((p) => p.editMs)),
          eventLoopP95Ms: lag.percentile(95) / 1e6,
          eventLoopMaxMs: lag.max / 1e6,
          gcMs: gc.reduce((n, x) => n + x.durationMs, 0),
          mainThreadCpuMs: (mainUsage.user + mainUsage.system) / 1000,
          workerThreadCpuMs: (workerUsage.user + workerUsage.system) / 1000,
          meetsHistoricalLimit: p95(phases.map((p) => p.serverMs)) <= 100,
        };
        assert.equal(edits.length, authors * 100);
        assert.equal(
          phases.reduce((n, p) => n + p.contributions, 0),
          authors * 100,
        );
        assert.equal(work.length, phases.length);
        process.send?.({
          kind: 'result',
          result: {
            summary,
            snapshotBytes: snapshot.length,
            businessBytes,
            clientIds,
            phases,
            poolSamples: [...poolSamples],
            edits,
            roomWaiting,
            roomIngress: [...roomIngress],
            gc,
          },
        });
        console.log(JSON.stringify(summary));
      }
    } catch (error) {
      workloadError = error;
      process.send?.({
        kind: 'result',
        result: {
          partial: true,
          stage: diagnosticStage,
          error: String(error),
          phases: [...phases],
          poolSamples: [...poolSamples],
          roomIngress: [...roomIngress],
        },
      });
    } finally {
      diagnosticStage = 'export-profiles-after-workloads';
      const label = `${mode}-${series}`;
      const cpuMain = await stopMain(label + '-server'),
        cpuWorker = await saveCpu(
          label + '-validator',
          JSON.parse(await workerCpu.stop()) as Profiler.Profile,
        );
      const clientProfiles = await Promise.all(
        peers.map((p, i) => ('stop' in p ? p.stop(label + `-client${i + 1}`) : null)),
      );
      process.send?.({
        kind: 'result',
        result: { profilesOnly: true, cpuMain, cpuWorker, clientProfiles },
      });
    }
    trace.restore();
    if (workloadError) throw workloadError;
  } finally {
    for (const peer of peers) await peer.close();
    proxy?.close();
    await host?.close();
    await auth.pool.end();
    await db.close();
  }
}
if (process.env.MEMORIA_HISTORY_ROLE === 'client') {
  let peer: LocalPeer | undefined, stop: Awaited<ReturnType<typeof startCpu>> | undefined;
  process.on(
    'message',
    (m: { id: number; op: string; config: PeerConfig; wave: number; label: string }) => {
      void (async () => {
        let result: unknown = null;
        if (m.op === 'init') peer = await localPeer(m.config);
        else if (m.op === 'edit') result = await peer!.edit(m.wave);
        else if (m.op === 'start') stop = await startCpu();
        else if (m.op === 'stop') {
          result = await stop!(m.label);
          stop = undefined;
        } else if (m.op === 'close') {
          await peer?.close();
          peer = undefined;
        } else throw new Error('Unknown profile client operation');
        process.send?.({ id: m.id, result });
      })().catch(() => {
        process.send?.({ id: m.id, error: 'PROFILE_CLIENT_FAILED' });
      });
    },
  );
  process.on('disconnect', () => {
    void peer?.close();
  });
} else if (process.env.MEMORIA_HISTORY_ROLE === 'server') {
  try {
    await runServer(
      process.env.MEMORIA_HISTORY_MODE as Mode,
      Number(process.env.MEMORIA_HISTORY_SERIES),
    );
  } catch (e) {
    console.error(e);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
} else {
  await mkdir(root, { recursive: true });
  const reports: object[] = [];
  for (let series = 1; series <= 3; series++)
    for (const mode of (series === 2 ? ['isolated', 'shared'] : ['shared', 'isolated']) as Mode[]) {
      const label = `history-profile-${series}-${mode}`,
        preparation = await prepareMeasurement(label);
      const child = fork(import.meta.filename, [], {
        env: {
          ...process.env,
          MEMORIA_HISTORY_ROLE: 'server',
          MEMORIA_HISTORY_MODE: mode,
          MEMORIA_HISTORY_SERIES: String(series),
        },
        windowsHide: true,
        stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      });
      let closed = false;
      const results: unknown[] = [];
      const ended = once(child, 'exit').then(([code]) => {
        closed = true;
        return code;
      });
      const prepared = new Promise<void>((yes, no) => {
        child.on('message', (m: { kind: string; result: unknown }) => {
          if (m.kind === 'prepared') yes();
          if (m.kind === 'result') results.push(m.result);
        });
        child.once('exit', () => no(new Error('Profile fixture exited before preparation')));
        child.once('error', no);
      });
      try {
        await prepared;
        const { result, hygiene } = await runMeasuredSeries(
          label,
          async () => {
            child.send({ kind: 'start' });
            return { code: await ended, results };
          },
          { preparation, maxAttempts: 1 },
        );
        reports.push({ mode, series, result, hygiene });
        await writeFile(
          resolve(root, 'measurement.json'),
          JSON.stringify(
            {
              date: new Date().toISOString(),
              diagnosticOnly: true,
              thresholdMs: 100,
              protocol:
                'AB/BA/AB, 110 waves at one author then 110 at two; first 10 warmups, 100ms pause. Same live app, CPU sampling enabled in both configurations. Exceedances retained for authorized diagnosis, no qualification or changed threshold.',
              reports,
            },
            null,
            2,
          ) + '\n',
        );
        assert.equal(result.code, 0);
      } finally {
        if (!closed) {
          child.send({ kind: 'cancel' });
          const timer = setTimeout(() => child.kill(), 15000);
          await ended;
          clearTimeout(timer);
        }
      }
    }
}
