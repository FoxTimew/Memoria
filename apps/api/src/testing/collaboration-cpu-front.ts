import assert from 'node:assert/strict';
import type { ChildProcess } from 'node:child_process';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { expect, type Page, type BrowserContext } from '@playwright/test';
import type { createDatabase } from '@memoria/db';

type Observation = { at: number; event?: string; [key: string]: unknown };
type Conversion = {
  profile: string;
  startedAt: number;
  completedAt: number;
  elapsedMs: number;
  cgroupPeakBytes: number;
  status: string;
  preview: string;
};
export async function prepareCpuConversions() {
  const conversions: Conversion[] = [],
    failures: string[] = [];
  const child = fork('scripts/file-mixed-converter.mjs', [], {
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const ended = once(child, 'exit');
  child.on('message', (m: { kind: string; result?: Conversion; error?: string }) => {
    if (m.kind === 'conversion') conversions.push(m.result!);
    if (m.kind === 'failure') failures.push(m.error ?? 'CONVERTER_FAILED');
  });
  await new Promise<void>((yes, no) => {
    child.on('message', (m: { kind: string }) => {
      if (m.kind === 'prepared') yes();
    });
    child.once('error', no);
    child.once('exit', () => no(Error('CPU_CONVERTER_PREPARATION_FAILED')));
  });
  return {
    child,
    conversions,
    failures,
    async stop() {
      if (child.connected) child.send({ kind: 'stop' });
      await ended;
    },
  };
}

async function observeContext(context: BrowserContext) {
  await context.addInitScript(() => {
    const events: { at: number; event: string; code?: number; reason?: string }[] = [];
    const Original = window.WebSocket;
    class Observed extends Original {
      constructor(url: string | URL, protocols?: string | string[]) {
        super(url, protocols);
        this.addEventListener('open', () => events.push({ at: Date.now(), event: 'open' }));
        this.addEventListener('close', (e) =>
          events.push({
            at: Date.now(),
            event: 'close',
            code: e.code,
            reason: ['CONTROL_UNAVAILABLE', 'SERVICE_UNAVAILABLE', 'ROOM_RELOAD_REQUIRED'].includes(
              e.reason,
            )
              ? e.reason
              : 'other',
          }),
        );
      }
    }
    window.WebSocket = Observed;
    Object.assign(window, { memoriaCpuSocketEvents: events });
  });
}
async function socketEvents(page: Page) {
  return page.evaluate(
    () =>
      (window as typeof window & { memoriaCpuSocketEvents: Observation[] }).memoriaCpuSocketEvents,
  );
}

export async function cpuFront(options: {
  page: Page;
  secondContext: BrowserContext;
  href: string;
  directory: string;
  pool: ReturnType<typeof createDatabase>['pool'];
  pageId: string;
  server: ChildProcess;
  observations: Observation[];
  converter: Awaited<ReturnType<typeof prepareCpuConversions>>;
  extended?: boolean;
}) {
  const { page, secondContext, href, pool, pageId, server, observations, converter } = options;
  const directory = resolve(options.directory);
  await observeContext(page.context());
  await observeContext(secondContext);
  const peer = await secondContext.newPage();
  const errors: string[] = [],
    quotas: number[] = [];
  for (const p of [page, peer]) {
    p.on('pageerror', (e) => errors.push(e.name));
    p.on('response', (r) => {
      if (r.status() === 429) quotas.push(r.status());
    });
    await p.goto(href);
    await expect(p.locator('.bn-editor[contenteditable="true"]')).toBeVisible({ timeout: 30000 });
    await expect(p.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
      timeout: 30000,
    });
  }
  const type = async (p: Page, text: string) => {
    const editor = p.locator('.bn-editor[contenteditable="true"]');
    await editor.click();
    await p.keyboard.press('Control+End');
    await p.keyboard.insertText(text);
  };
  const revision = async () =>
    Number(
      (
        await pool.query('SELECT content_revision FROM collaboration_documents WHERE page_id=$1', [
          pageId,
        ])
      ).rows[0].content_revision,
    );
  const baseline = 'CPU baseline confirmed. ';
  await type(page, baseline);
  await expect(peer.locator('.bn-editor')).toContainText(baseline);
  await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
  const before = await revision();
  process.send?.({ kind: 'prepared' });
  await new Promise<void>((yes, no) =>
    process.once('message', (m: { kind: string }) =>
      m.kind === 'start' ? yes() : no(Error('CPU_MEASUREMENT_CANCELLED')),
    ),
  );
  const start = Date.now(),
    phases: object[] = [],
    typed: string[] = [];
  let outcome = 'pending',
    error: string | undefined,
    controlClosed = false;
  let cpuStoppedAt: number | undefined, recoveredAt: number | undefined;
  const locallyVisible: object[] = [];
  try {
    converter.child.send({ kind: 'start' });
    server.send!({ kind: 'cpu-start' });
    const until = async (milliseconds: number, stage: string) => {
      const end = Date.now() + milliseconds;
      let n = 0;
      while (Date.now() < end) {
        if (converter.failures.length) throw Error(converter.failures[0]);
        const token = `cpu-${stage}-${n++} `;
        if (await page.locator('.bn-editor[contenteditable="true"]').count()) {
          await type(page, token);
          typed.push(token);
        }
        controlClosed = (await socketEvents(page)).some((e) => e.reason === 'CONTROL_UNAVAILABLE');
        if (controlClosed) break;
        await delay(350);
      }
    };
    phases.push({ stage: 'four-cpu-workers-and-8k', at: Date.now() });
    await until(12000, 'workers');
    // A bounded, explicit main-loop workload exposes the suspected callback starvation.
    // It does not claim that normal admitted edits generate these bursts in production.
    for (const duration of [250, 750, 1800, ...(options.extended ? [3500] : [])]) {
      if (controlClosed) break;
      phases.push({
        stage: 'yjs-burst-during-real-control-query',
        at: Date.now(),
        requestedMs: duration,
      });
      server.send!({ kind: 'cpu-burst', burstMs: duration });
      await until(7000, String(duration));
    }
    server.send!({ kind: 'cpu-stop' });
    await expect
      .poll(() => observations.some((o) => o.event === 'cpu-stopped'), { timeout: 15000 })
      .toBe(true);
    cpuStoppedAt = Date.now();
    await converter.stop();
    if (converter.failures.length) throw Error(converter.failures[0]);
    assert(
      converter.conversions.some(
        (c) => c.profile === 'noise' && c.startedAt <= cpuStoppedAt! && c.completedAt >= start,
      ),
    );
    for (const conversion of converter.conversions) {
      assert.equal(conversion.status, 'validated');
      assert.equal(conversion.preview, 'available');
      assert(
        conversion.elapsedMs < 30000 && conversion.cgroupPeakBytes <= 512 * 1024 ** 2,
        'STOP_CPU_CONVERTER_LIMIT',
      );
    }
    if (controlClosed) {
      const token = 'CPU local text after control closure. ';
      if (await page.locator('.bn-editor[contenteditable="true"]').count()) {
        await type(page, token);
        typed.push(token);
      }
      const deadline = Date.now() + 60000;
      while (Date.now() < deadline) {
        const status = await page.getByTestId('save-status').textContent();
        if (
          status === 'Enregistré sur le serveur' &&
          (await peer.locator('.bn-editor').textContent())?.includes(typed.at(-1)!)
        ) {
          recoveredAt = Date.now();
          break;
        }
        await delay(1000);
      }
    } else {
      await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
        timeout: 30000,
      });
    }
    assert.deepEqual(errors, [], 'Front JavaScript failure');
    assert.deepEqual(quotas, [], 'STOP_CPU_QUOTA');
    if (controlClosed && !recoveredAt)
      throw Error('CONTROL_UNAVAILABLE_NO_AUTOMATIC_RECOVERY_OBSERVED_60S');
    const text = (await peer.locator('.bn-editor').textContent()) ?? '';
    assert(
      typed.every((token) => text.includes(token)),
      'CPU_TEXT_NOT_CONVERGED',
    );
    await page.reload();
    await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
      timeout: 30000,
    });
    const reloaded = (await page.locator('.bn-editor').textContent()) ?? '';
    assert(
      typed.every((token) => reloaded.includes(token)),
      'CPU_TEXT_MISSING_AFTER_RELOAD',
    );
    outcome = controlClosed ? 'control-closure-recovered' : 'no-control-closure-observed';
  } catch (e) {
    outcome = 'stopped';
    error = (e as Error).message;
  } finally {
    if (server.connected) server.send({ kind: 'cpu-stop' });
    await converter.stop();
    // Preserve evidence even if the save-status assertion failed before recovery.
    for (const [name, p] of [
      ['author', page],
      ['peer', peer],
    ] as const) {
      const text =
        (await p
          .locator('.bn-editor')
          .textContent({ timeout: 3000 })
          .catch(() => null)) ?? '';
      locallyVisible.push({
        client: name,
        baseline: text.includes(baseline),
        tokens: typed.map((token) => text.includes(token)),
        status: await p
          .getByTestId('save-status')
          .textContent({ timeout: 3000 })
          .catch(() => null),
        sockets: await socketEvents(p).catch(() => []),
      });
      await p
        .screenshot({ path: resolve(directory, 'cpu-' + name + '.png'), fullPage: true })
        .catch(() => {});
    }
    const report = {
      date: new Date().toISOString(),
      extended: options.extended ?? false,
      scope:
        'Diagnostic on real built front, real server/Caddy/PostgreSQL; four bounded CPU workers plus explicit Yjs main-loop bursts during real control queries; no injected SQL delay or fail() call. Not a latency qualification or a claim of a normal-client attack.',
      start,
      end: Date.now(),
      phases,
      outcome,
      error,
      controlClosed,
      cpuStoppedAt,
      recoveredAt,
      recoveryObservationMs: 60000,
      revisionBefore: before,
      revisionAfter: await revision(),
      typedCount: typed.length,
      locallyVisible,
      errors,
      quotas,
      observations,
      conversions: converter.conversions,
      converterFailures: converter.failures,
    };
    await mkdir('.local/7d', { recursive: true });
    await writeFile(resolve(directory, 'cpu-report.json'), JSON.stringify(report, null, 2) + '\n');
    await writeFile(
      '.local/7d/cpu-latest.json',
      JSON.stringify({ directory, ...report }, null, 2) + '\n',
    );
    console.info('CPU diagnostic report: ' + resolve(directory, 'cpu-report.json'));
    await secondContext.close();
  }
  if (error) throw Error(error);
}
