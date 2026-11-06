// Injected only into diagnostic bundles by --profile-worker. Never imported by production.
import { PerformanceObserver } from 'node:perf_hooks';
import { threadId } from 'node:worker_threads';
type Gc = { start: number; duration: number; kind: number | null };
const gc: Gc[] = [];
const observer = new PerformanceObserver((list) => {
  for (const entry of list.getEntries())
    gc.push({
      start: entry.startTime,
      duration: entry.duration,
      kind: (entry as unknown as { detail?: { kind: number } }).detail?.kind ?? null,
    });
});
observer.observe({ entryTypes: ['gc'] });
let stages: Record<string, number> = {};
let started = 0,
  heapBefore = 0;
export function beginWorkerProfile() {
  stages = {};
  started = performance.now();
  heapBefore = process.memoryUsage().heapUsed;
}
export function measureWorkerStage<T>(name: string, work: () => T): T {
  const start = performance.now();
  try {
    return work();
  } finally {
    stages[name] = (stages[name] ?? 0) + performance.now() - start;
  }
}
export function recordWorkerStage(name: string, start: number) {
  stages[name] = (stages[name] ?? 0) + performance.now() - start;
}
export function endWorkerProfile() {
  for (const entry of observer.takeRecords())
    gc.push({
      start: entry.startTime,
      duration: entry.duration,
      kind: (entry as unknown as { detail?: { kind: number } }).detail?.kind ?? null,
    });
  return {
    threadId,
    origin: performance.timeOrigin,
    started,
    ended: performance.now(),
    heapBefore,
    heapAfter: process.memoryUsage().heapUsed,
    stages,
    gc: gc.splice(0),
  };
}
