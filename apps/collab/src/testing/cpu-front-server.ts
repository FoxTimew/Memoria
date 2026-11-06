// Test entry only: real production service, diagnostic CPU work controlled by private IPC.
import { Worker } from 'node:worker_threads';
import { availableParallelism } from 'node:os';
import { performance, monitorEventLoopDelay } from 'node:perf_hooks';
import { setTimeout as delay } from 'node:timers/promises';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import { createDatabase } from '@memoria/db';
import { createAuth } from '@memoria/auth';
import * as Y from 'yjs';
import type { Client } from 'pg';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { Leadership } from '../service/leadership.ts';
import { Revocations } from '../service/revocations.ts';

if (!process.send) throw Error('CPU_FIXTURE_REQUIRES_PRIVATE_IPC');
const send = (value: object) =>
  process.send?.({ kind: 'cpu-observation', at: Date.now(), ...value });
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
