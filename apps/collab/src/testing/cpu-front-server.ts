// Test entry only: real production service, diagnostic CPU work controlled by private IPC.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabase } from '@memoria/db';
import { createAuth } from '@memoria/auth';
import * as Y from 'yjs';
import type { Client } from 'pg';
import WebSocket from 'ws';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { Leadership } from '../service/leadership.ts';
import { Revocations } from '../service/revocations.ts';
import { Room } from '../service/room.ts';
import { Store } from '../service/store.ts';
import { Admission } from '../service/admission.ts';
import { publicError } from '../service/public-error.ts';
import { CandidateRejected } from '../validator.ts';
import { decodeDocument } from '../codec.ts';

if (!process.send) throw Error('CPU_FIXTURE_REQUIRES_PRIVATE_IPC');
const send = (value: object) =>
  process.send?.({ kind: 'cpu-observation', at: Date.now(), ...value });
// Fixed codes only: no SQL text, user data, room IDs, session tokens or arbitrary error messages.
const errorFields = (error: unknown) => ({
  reason:
    error instanceof Error && error.message === 'COLLAB_LEADERSHIP_LOST'
      ? 'COLLAB_LEADERSHIP_LOST'
      : publicError(error, 'UNCLASSIFIED').message,
  candidateRejected: error instanceof CandidateRejected,
});
const fenceDescriptor = Object.getOwnPropertyDescriptor(Leadership.prototype, 'fence')!;
Object.defineProperty(Leadership.prototype, 'fence', {
  ...fenceDescriptor,
  get(this: Leadership) {
    try {
      return fenceDescriptor.get!.call(this);
    } catch (error) {
      send({
        event: 'fence-rejected',
        ...errorFields(error),
        ageMs: Date.now() - Number(Reflect.get(this, 'acknowledged')),
        stopped: Reflect.get(this, 'stopped') === true,
      });
      throw error;
    }
  },
});
const admissionReceive = Admission.prototype.receive;
Admission.prototype.receive = function (...args: Parameters<typeof admissionReceive>) {
  try {
    return admissionReceive.apply(this, args);
  } catch (error) {
    send({
      event: 'admission-rejected',
      ...errorFields(error),
      ready: args[0].ready,
      handshakeCount: args[0].handshakeCount,
      handshakeBytes: args[0].handshakeBytes,
    });
    throw error;
  }
};
const roomUpdate = Room.prototype.update;
Room.prototype.update = function (...args: Parameters<typeof roomUpdate>) {
  return roomUpdate.apply(this, args).catch(async (error: unknown) => {
    send({ event: 'room-update-rejected', ...errorFields(error), fatal: this.fatal });
    if (error instanceof CandidateRejected) {
      // Synthetic test content only. Reproduce the full codec separately; do not
      // alter the rejecting worker or pass diagnostic errors to the wire.
      const snapshot = Y.encodeStateAsUpdate(this.doc),
        candidate = new Y.Doc();
      candidate.getXmlFragment('prosemirror');
      let reason = 'VALID_IN_FULL_CODEC';
      try {
        Y.applyUpdate(candidate, snapshot);
        Y.applyUpdate(candidate, args[1]);
        decodeDocument(candidate);
      } catch (replayError) {
        const allowed = new Set([
          'Unresolved Yjs dependencies',
          'Unknown shared root',
          'Duplicate block ID',
          'Too many Yjs structures',
          'Expected one block group',
          'Maximum document size',
        ]);
        reason =
          replayError instanceof Error && allowed.has(replayError.message)
            ? replayError.message
            : 'OTHER_CODEC_REFUSAL';
      }
      const directory = `.local/7d/cpu-rejected-${process.pid}-${Date.now()}`;
      await mkdir(directory, { recursive: true });
      await writeFile(`${directory}/snapshot.bin`, snapshot);
      await writeFile(`${directory}/update.bin`, args[1]);
      send({
        event: 'candidate-replay',
        reason,
        directory,
        snapshotBytes: snapshot.length,
        updateBytes: args[1].length,
        pendingStructs: Boolean(candidate.store.pendingStructs),
        pendingDs: Boolean(candidate.store.pendingDs),
      });
      candidate.destroy();
    }
    throw error;
  });
};
for (const name of ['open', 'authorize'] as const) {
  const method = Store.prototype[name];
  Object.defineProperty(Store.prototype, name, {
    ...Object.getOwnPropertyDescriptor(Store.prototype, name),
    value: function (this: Store, ...args: Parameters<typeof method>) {
      return Reflect.apply(method, this, args).catch((error: unknown) => {
        send({ event: 'store-rejected', operation: name, ...errorFields(error) });
        throw error;
      });
    },
  });
}
const socketIds = new WeakMap<WebSocket, number>();
const closeCodes = new Set([
  'DOCUMENT_CLOSED',
  'CONTROL_UNAVAILABLE',
  'AUTH_REJECTED',
  'DOCUMENT_LOAD_FAILED',
  'UPDATE_REJECTED',
  'FRAME_REJECTED',
  'PRESENCE_REJECTED',
]);
let nextSocketId = 0;
const closeSocket = WebSocket.prototype.close;
WebSocket.prototype.close = function (...args: Parameters<typeof closeSocket>) {
  if (!socketIds.has(this)) socketIds.set(this, ++nextSocketId);
  const reason = typeof args[1] === 'string' ? args[1] : args[1]?.toString('utf8');
  send({
    event: 'socket-close-requested',
    socket: socketIds.get(this),
    code: args[0] ?? null,
    reason:
      reason && closeCodes.has(reason)
        ? reason
        : publicError(new Error(reason ?? ''), 'OTHER').message,
  });
  return closeSocket.apply(this, args);
};
// Read the immutable campaign fixture; never import its BlockNote input generator
// into this real server entry. The normal no-UI build boundary remains enforced.
const bytes = await readFile('.local/incremental/history-1M.bin'),
  document = new Y.Doc();
if (bytes.length < 768 * 1024 || bytes.length > 1024 ** 2)
  throw Error('CPU_HISTORY_FIXTURE_SIZE_INVALID');
Y.applyUpdate(document, bytes);
let pendingBurst = 0,
  stopping = false;
function burn(milliseconds: number) {
  const start = performance.now(),
    cpu = process.threadCpuUsage();
  let operations = 0;
  while (performance.now() - start < milliseconds) {
    Y.snapshotContainsUpdate(Y.snapshot(document), bytes);
    operations++;
  }
  send({
    event: 'main-yjs-burst',
    requestedMs: milliseconds,
    elapsedMs: performance.now() - start,
    operations,
    threadCpu: process.threadCpuUsage(cpu),
  });
}
function trace(name: string, client: Client) {
  client.on('error', (e: Error & { code?: string }) =>
    send({ event: 'control-error', control: name, name: e.name, code: e.code }),
  );
  client.on('end', () => send({ event: 'control-end', control: name }));
  const query = client.query;
  client.query = function (this: Client, ...args: unknown[]) {
    const start = performance.now();
    const result = Reflect.apply(query, this, args) as Promise<unknown>;
    if (pendingBurst) {
      const duration = pendingBurst;
      pendingBurst = 0;
      // Actual CPU work while a real control query is in flight. No fake SQL delay/error,
      // no call to fail(), no changed lease or query deadline.
      queueMicrotask(() => burn(duration));
    }
    return result.then(
      (v) => {
        send({
          event: 'control-query',
          control: name,
          elapsedMs: performance.now() - start,
          ok: true,
        });
        return v;
      },
      (e: Error & { code?: string }) => {
        send({
          event: 'control-query',
          control: name,
          elapsedMs: performance.now() - start,
          ok: false,
          name: e.name,
          code: e.code,
          timeout: /timeout/i.test(e.message),
        });
        throw e;
      },
    );
  } as typeof client.query;
}
for (const [name, constructor] of [
  ['leadership', Leadership],
  ['revocations', Revocations],
] as const) {
  const start = constructor.prototype.start;
  constructor.prototype.start = async function (this: Leadership | Revocations) {
    trace(name, (this as unknown as { control: Client }).control);
    return Reflect.apply(start, this, []);
  } as typeof start;
}
const config = readCollabConfig(),
  { db, pool } = createDatabase(config.DATABASE_URL, { pipeline: true });
const auth = createAuth(db, {
  origin: config.APP_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  sendVerificationEmail: async () => {
    throw Error('Session verification only');
  },
});
const server = await collaborationServer(config, pool, sessionVerifier(auth));
const workers: Worker[] = [];
const lag = monitorEventLoopDelay({ resolution: 10 });
lag.enable();
let sampler: ReturnType<typeof setInterval> | undefined;
process.on('message', (message: { kind?: string; burstMs?: number }) => {
  if (message.kind === 'cpu-start') {
    if (workers.length || sampler) return;
    const count = Math.min(4, Math.max(1, availableParallelism() - 2));
    for (let i = 0; i < count; i++)
      workers.push(
        new Worker(
          `const {parentPort}=require('node:worker_threads'); let n=1; const end=Date.now()+120000; while(Date.now()<end) { for(let i=0;i<100000;i++) n=Math.sqrt(n+1); } parentPort.postMessage(n);`,
          {
            eval: true,
            resourceLimits: { maxOldGenerationSizeMb: 32, maxYoungGenerationSizeMb: 4 },
          },
        ),
      );
    let cpu = process.cpuUsage(),
      at = performance.now();
    sampler = setInterval(() => {
      const now = performance.now(),
        usage = process.cpuUsage(cpu);
      send({
        event: 'cpu-sample',
        intervalMs: now - at,
        cpu: usage,
        processCpuCores: (usage.user + usage.system) / ((now - at) * 1000),
        lagMaxMs: lag.max / 1e6,
        lagP95Ms: lag.percentile(95) / 1e6,
        memory: process.memoryUsage(),
        workers: count,
      });
      cpu = process.cpuUsage();
      at = now;
      lag.reset();
    }, 500);
    send({ event: 'cpu-started', workers: count, logicalCpus: availableParallelism() });
  } else if (message.kind === 'cpu-burst') {
    if (![250, 750, 1800, 3500].includes(message.burstMs ?? 0))
      throw Error('INVALID_CPU_DIAGNOSTIC_STEP');
    pendingBurst = message.burstMs!;
    send({ event: 'burst-armed', milliseconds: pendingBurst });
  } else if (message.kind === 'cpu-stop') {
    pendingBurst = 0;
    void Promise.all(workers.splice(0).map((worker) => worker.terminate())).then(() => {
      clearInterval(sampler);
      sampler = undefined;
      send({ event: 'cpu-stopped', lagMaxMs: lag.max / 1e6 });
    });
  }
});
send({
  event: 'ready',
  profileBytes: bytes.length,
  profileSha256: createHash('sha256').update(bytes).digest('hex'),
});
for (const signal of ['SIGTERM', 'SIGINT', 'disconnect'] as const)
  process.once(signal, () => {
    if (stopping) return;
    stopping = true;
    clearInterval(sampler);
    void (async () => {
      await Promise.all(workers.splice(0).map((worker) => worker.terminate()));
      await server.close();
      await pool.end();
      document.destroy();
      lag.disable();
      await delay(0);
      process.disconnect?.();
    })();
  });
