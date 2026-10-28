import { describe, it, expect, vi } from 'vitest';
import {
  parseWslSnapshot,
  assertMemoryStage,
  parseVmstat,
  assessSwap,
  runMeasuredSeries,
} from './measurement-memory.mjs';
const boot = 'dc1818ce-057f-406e-9e82-a0bb01fa6a48';
const snapshot = (windows = 3, wsl = 2) => ({
  observedAt: new Date().toISOString(),
  windowsFreeBytes: windows * 1024 ** 3,
  power: { allowed: true },
  wsl: { bootId: boot, memAvailableBytes: wsl * 1024 ** 3, swapInPages: 11, swapOutPages: 12 },
});
const raw = (si = 0, so = 0) =>
  `BOOT ${boot}\nvmstat from procps-ng 4.0.4\nprocs -----------memory---------- ---swap-- -----io---- -system-- ------cpu-----\n r b swpd free buff cache si so bi bo in cs us sy id wa st\n 0 0 0 100 10 20 0 0 0 0 0 0 0 0 100 0 0\n 0 0 0 100 10 20 ${si} ${so} 0 0 0 0 0 0 100 0 0\n`;
const trace = (si = 0, so = 0) => ({
  raw: raw(si, so),
  startedAt: 0,
  workStartedAt: 1,
  workEndedAt: 2,
  endedAt: 3,
});

describe('Windows/WSL memory hygiene, 26 October 2026', () => {
  it('parses actual kernel counters and MemAvailable, never substitutes MemFree/cache', () => {
    expect(
      parseWslSnapshot(
        `BOOT ${boot}\nMemFree: 123 kB\nMemAvailable: 2097152 kB\nCached: 9999 kB\npswpin 11\npswpout 12\n`,
      ),
    ).toEqual(snapshot().wsl);
    for (const data of [
      '',
      `BOOT ${boot}\nMemFree: 123 kB\npswpin 0\npswpout 0\n`,
      `BOOT ${boot}\nMemAvailable: NaN kB\npswpin 0\npswpout 0\n`,
    ])
      expect(() => parseWslSnapshot(data)).toThrow('WSL_MEMORY_PROBE_FAILED');
  });
  it('requires 3 GiB BEFORE preparation; cached Linux memory cannot replace this requirement', () => {
    expect(() => assertMemoryStage(snapshot(3, 1), 'before-preparation')).not.toThrow();
    expect(() => assertMemoryStage(snapshot(2.999, 8), 'before-preparation')).toThrow(
      'WINDOWS_BEFORE_PREPARATION',
    );
  });
  it('requires Windows 1.5 GiB AND WSL 2 GiB AFTER preparation', () => {
    expect(() => assertMemoryStage(snapshot(1.5, 2), 'after-preparation')).not.toThrow();
    for (const pair of [
      [1.499, 10],
      [9, 1.999],
      [NaN, 2],
      [3, NaN],
    ])
      expect(() => assertMemoryStage(snapshot(...pair), 'after-preparation')).toThrow();
    expect(() =>
      assertMemoryStage({ ...snapshot(), power: { allowed: false } }, 'after-preparation'),
    ).toThrow('secteur');
  });
  it('uses named si/so columns and rejects truncated/malformed numeric rows', () => {
    expect(parseVmstat(raw(4, 8)).rows).toEqual([
      { si: 0, so: 0 },
      { si: 4, so: 8 },
    ]);
    expect(() => parseVmstat(raw().replace('100 0 0\n', '100 0\n'))).toThrow('INVALID_VMSTAT_ROW');
  });
  it('invalidates ANY swap, including a single page invisible in rounded rates', () => {
    expect(assessSwap(trace(), snapshot(), snapshot()).valid).toBe(true);
    for (const t of [trace(1, 0), trace(0, 1)])
      expect(assessSwap(t, snapshot(), snapshot())).toMatchObject({
        valid: false,
        reason: 'SWAP_ACTIVITY',
      });
    const after = snapshot();
    after.wsl.swapOutPages++;
    expect(assessSwap(trace(), snapshot(), after)).toMatchObject({
      valid: false,
      reason: 'SWAP_ACTIVITY',
      deltaOutPages: 1,
    });
  });
  it('fails closed on another kernel, reset counters, missing monitor or incomplete coverage', () => {
    const other = snapshot();
    other.wsl.bootId = 'another-kernel';
    expect(assessSwap(trace(), snapshot(), other).valid).toBe(false);
    const reset = snapshot();
    reset.wsl.swapInPages = 0;
    expect(assessSwap(trace(), snapshot(), reset).reason).toBe('SWAP_COUNTER_RESET_OR_INVALID');
    for (const t of [
      { ...trace(), raw: '' },
      { ...trace(), probeError: 'exited' },
      { ...trace(), stderr: 'error' },
      { ...trace(), workStartedAt: undefined },
      { ...trace(), startedAt: 2 },
      { ...trace(), endedAt: 1 },
    ])
      expect(assessSwap(t, snapshot(), snapshot()).valid).toBe(false);
  });
  it('retains a rejected attempt and reruns fresh work, never returns its samples', async () => {
    let n = 0;
    const saved = [];
    const close = vi.fn();
    const work = vi.fn(async () => ({ samples: [++n] }));
    const { result, hygiene } = await runMeasuredSeries('unit-retry', work, {
      read: () => snapshot(),
      monitor: async () => ({
        finish: async () => ({ ...trace(n === 1 ? 1 : 0), startedAt: 0, endedAt: Date.now() + 1 }),
        close,
      }),
      persist: async (path, data) => saved.push({ path, ...data }),
    });
    expect(result.samples).toEqual([2]);
    expect(work).toHaveBeenCalledTimes(2);
    expect(close).toHaveBeenCalledTimes(2);
    expect(saved.map((s) => s.status)).toEqual(['invalid', 'valid']);
    expect(saved[0].result.samples).toEqual([1]);
    expect(hygiene.attempts).toHaveLength(2);
  });
  it('stops after three swapped attempts and retains all three', async () => {
    const saved = [];
    await expect(
      runMeasuredSeries('unit-exhausted', async () => 1, {
        read: () => snapshot(),
        monitor: async () => ({
          finish: async () => ({ ...trace(1), startedAt: 0, endedAt: Date.now() + 1 }),
          close: () => {},
        }),
        persist: async (_, data) => saved.push(data),
      }),
    ).rejects.toThrow('SWAP_RETRY_EXHAUSTED');
    expect(saved.map((s) => s.status)).toEqual(['invalid', 'invalid', 'invalid']);
  });
  it('a missing probe or workload error cannot become a retry/valid series; cleanup still runs', async () => {
    const persist = vi.fn(),
      close = vi.fn(),
      work = vi.fn(async () => {
        throw new Error('SQL failed');
      });
    await expect(
      runMeasuredSeries('unit-failure', work, {
        read: () => snapshot(),
        monitor: async () => ({ close }),
        persist,
      }),
    ).rejects.toThrow('SQL failed');
    expect(work).toHaveBeenCalledTimes(1);
    expect(close).toHaveBeenCalledOnce();
    expect(persist.mock.calls[0][1].status).toBe('error');
    const denied = vi.fn();
    await expect(
      runMeasuredSeries('unit-denied', denied, { read: () => snapshot(1), persist }),
    ).rejects.toThrow('WINDOWS_AFTER_PREPARATION');
    expect(denied).not.toHaveBeenCalled();
  });
  it('never certifies a series when its monitor cannot be cleaned up', async () => {
    const persist = vi.fn();
    await expect(
      runMeasuredSeries('unit-cleanup', async () => 1, {
        read: () => snapshot(),
        monitor: async () => ({
          finish: async () => ({ ...trace(), startedAt: 0, endedAt: Date.now() + 1 }),
          close: async () => {
            throw new Error('cleanup failed');
          },
        }),
        persist,
      }),
    ).rejects.toThrow('cleanup failed');
    expect(persist.mock.calls[0][1]).toMatchObject({
      status: 'error',
      cleanupError: 'cleanup failed',
    });
  });
});
