// Disposable diagnostic process only. No deadlines, SQL or scheduling behavior are changed.
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { Session } from 'node:inspector/promises';
import type { Profiler } from 'node:inspector';
import { monitorEventLoopDelay } from 'node:perf_hooks';
import { writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { gzipSync } from 'node:zlib';
import type { Worker } from 'node:worker_threads';
import type { Pool, PoolClient } from 'pg';
import type { collaborationServer } from '../service/server.ts';
import { receiptFor } from '../service/store.ts';

type Job = { id: number; replica: number; operation: string };
type Slot = { id: number; worker: Worker; queue: Job[]; active?: Job; failed: boolean };
type Reply = { elapsed: number; result: unknown };
type Probe = {
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
export async function mixedProfile(
  host: Awaited<ReturnType<typeof collaborationServer>>,
  pool: Pool,
  url: string,
  directory: string,
  label: string,
) {
  const p = host.validators as unknown as Probe;
  const originalDispatch = p.dispatch,
    originalEnqueue = p.enqueue;
  const dispatched = new Map<number, number>();
  const jobs: object[] = [],
    queries: object[] = [],
    lagSamples: object[] = [];
  let active = false,
    finished = false,
    started = false;
  const observer = fork(resolve('scripts/mixed-sql-observer.mjs'), [], {
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const observerEnded = once(observer, 'exit');
  const sqlPath = resolve(directory, label + '-sql.json');
  observer.send({ kind: 'configure', url, output: sqlPath });
  await new Promise<void>((yes, no) => {
    observer.on('message', (m: { kind: string }) => {
      if (m.kind === 'ready') yes();
    });
    observer.once('error', no);
    observer.once('exit', () => no(Error('SQL_OBSERVER_START_FAILED')));
  });
  const pids = new Set<number>();
  const restored: (() => void)[] = [];
  const instrument = (client: PoolClient) => {
    const pid = (client as unknown as { processID: number }).processID;
    pids.add(pid);
    observer.send({ kind: 'pids', pids: [...pids] });
    const query = client.query;
    client.query = function (...args: unknown[]) {
      const input = args[0] as string | { text: string; name?: string };
      // Query text is schema code only, never record values, result rows, URLs or credentials.
      const text = typeof input === 'string' ? input : input.text;
      const tag =
        typeof input === 'string'
          ? text.replace(/\s+/g, ' ').slice(0, 180)
          : (input.name ?? text.replace(/\s+/g, ' ').slice(0, 180));
      const from = performance.now(),
        record = active;
      const done = () => {
        if (record) queries.push({ pid, tag, from, to: performance.now() });
      };
      const callback = args.at(-1);
      if (typeof callback === 'function')
        args[args.length - 1] = (...values: unknown[]) => {
          done();
          return Reflect.apply(callback, undefined, values);
        };
      const result = Reflect.apply(query, client, args);
      return result && typeof result.then === 'function' ? result.finally(done) : result;
    } as typeof client.query;
    restored.push(() => {
      client.query = query;
    });
  };
  for (const c of (pool as unknown as { _clients: PoolClient[] })._clients) instrument(c);
  pool.on('connect', instrument);
  p.dispatch = function (slot) {
    if (!slot.failed && !slot.active && slot.queue.length)
      dispatched.set(slot.queue[0]!.id, performance.now());
    return originalDispatch.call(this, slot);
  };
  p.enqueue = async function (slot, replica, operation, data, deadline) {
    const from = performance.now(),
      record = active;
    const busy = slot.active ? { ...slot.active, data: undefined } : null;
    const queued = slot.queue.map((j) => ({
      id: j.id,
      replica: j.replica,
      operation: j.operation,
    }));
    const receipts = (data as { updates?: Uint8Array[] }).updates?.map(receiptFor);
    const result = originalEnqueue.call(this, slot, replica, operation, data, deadline),
      id = this.nextId;
    try {
      const reply = await result,
        to = performance.now(),
        sent = dispatched.get(id);
      if (record && sent !== undefined)
        jobs.push({
          id,
          replica,
          worker: slot.id,
          operation,
          from,
          sent,
          to,
          receipts,
          activeAtEnqueue: busy && {
            id: busy.id,
            replica: busy.replica,
            operation: busy.operation,
          },
          queued,
          waitMs: sent - from,
          workerMs: reply.elapsed,
          outsideWorkerMs: to - sent - reply.elapsed,
        });
      return reply;
    } finally {
      dispatched.delete(id);
    }
  };
  const cpu = new Session();
  const lag = monitorEventLoopDelay({ resolution: 5 });
  let lagTimer: ReturnType<typeof setInterval> | undefined;
  const workers = [...p.slots];
  let cpuHandles: Awaited<ReturnType<Worker['startCpuProfile']>>[] = [];
  let mainUsage = { user: 0, system: 0 };
  let workerUsage: Awaited<ReturnType<Worker['cpuUsage']>>[] = [];
  const saveCpu = async (name: string, profile: Profiler.Profile) => {
    await writeFile(resolve(directory, name + '.cpuprofile.gz'), gzipSync(JSON.stringify(profile)));
    return name + '.cpuprofile.gz';
  };
  return {
    async start() {
      cpu.connect();
      await cpu.post('Profiler.enable');
      await cpu.post('Profiler.start');
      started = true;
      cpuHandles = await Promise.all(workers.map((s) => s.worker.startCpuProfile()));
      mainUsage = process.threadCpuUsage();
      workerUsage = await Promise.all(workers.map((s) => s.worker.cpuUsage()));
      active = true;
      observer.send({ kind: 'start' });
      lag.enable();
      let expected = performance.now() + 20;
      lagTimer = setInterval(() => {
        const now = performance.now();
        lagSamples.push({ at: now, delayMs: Math.max(0, now - expected) });
        expected = now + 20;
      }, 20);
    },
    async finish() {
      if (finished) return;
      finished = true;
      active = false;
      clearInterval(lagTimer);
      lag.disable();
      pool.off('connect', instrument);
      for (const restore of restored) restore();
      p.dispatch = originalDispatch;
      p.enqueue = originalEnqueue;
      if (observer.connected) observer.send({ kind: 'stop' });
      const timeout = setTimeout(() => observer.kill(), 10000);
      const sql = observerEnded.then(async ([code]) => {
        clearTimeout(timeout);
        const result = JSON.parse(await readFile(sqlPath, 'utf8'));
        if (code !== 0)
          throw Error('SQL_OBSERVER_FAILED: ' + JSON.stringify(result.samples.at(-1)));
        return result;
      });
      void sql.catch(() => {});
      if (!started) {
        await sql;
        return { diagnosticOnly: true, cancelledBeforeMeasurement: true };
      }
      const main = process.threadCpuUsage(mainUsage);
      const cpuWorkers = await Promise.all(
        workers.map((s, i) => s.worker.cpuUsage(workerUsage[i])),
      );
      const cpuFiles = [
        await saveCpu(label + '-server', (await cpu.post('Profiler.stop')).profile),
      ];
      for (let i = 0; i < workers.length; i++)
        cpuFiles.push(
          await saveCpu(
            label + '-worker-' + workers[i]!.id,
            JSON.parse(await cpuHandles[i]!.stop()) as Profiler.Profile,
          ),
        );
      cpu.disconnect();
      const waits = await sql;
      return {
        diagnosticOnly: true,
        cpuFiles,
        mainThreadCpuMs: (main.user + main.system) / 1000,
        workers: workers.map((s, i) => ({
          id: s.id,
          cpuMs: (cpuWorkers[i]!.user + cpuWorkers[i]!.system) / 1000,
        })),
        eventLoopP95Ms: lag.percentile(95) / 1e6,
        eventLoopMaxMs: lag.max / 1e6,
        lagSamples,
        jobs,
        queries,
        sql: waits,
      };
    },
  };
}
