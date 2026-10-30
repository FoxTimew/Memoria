import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { expect, type Page, type WebSocket } from '@playwright/test';
import type { createDatabase } from '@memoria/db';

// Read only the bounded routing envelope; never record authentication frames or document bytes.
function frameType(payload: Buffer | string) {
  if (typeof payload === 'string') return undefined;
  let offset = 0;
  const uint = () => {
    let value = 0;
    for (let shift = 0; shift < 35; shift += 7) {
      const n = payload[offset++];
      if (n === undefined) throw Error('Incomplete frame');
      value += (n & 127) * 2 ** shift;
      if (!(n & 128)) return value;
    }
    throw Error('Invalid frame');
  };
  try {
    const nameLength = uint();
    offset += nameLength;
    if (offset >= payload.length) return undefined;
    return uint();
  } catch {
    return undefined;
  }
}

/** Real built front, one browser page, no input/reload during the 305-second observation. */
export async function idleFront(
  page: Page,
  pool: ReturnType<typeof createDatabase>['pool'],
  pageId: string,
  href: string,
  directory: string,
) {
  const sockets: WebSocket[] = [],
    events: { at: number; kind: string; type?: number | undefined }[] = [],
    failures: string[] = [],
    rateLimits: number[] = [];
  page.on('websocket', (socket) => {
    if (new URL(socket.url()).pathname !== '/collab') return;
    sockets.push(socket);
    events.push({ at: Date.now(), kind: 'open' });
    socket.on('close', () => events.push({ at: Date.now(), kind: 'close' }));
    socket.on('socketerror', () => failures.push('WEBSOCKET_ERROR'));
    socket.on('framesent', ({ payload }) =>
      events.push({ at: Date.now(), kind: 'sent', type: frameType(payload) }),
    );
    socket.on('framereceived', ({ payload }) =>
      events.push({ at: Date.now(), kind: 'received', type: frameType(payload) }),
    );
  });
  page.on('pageerror', () => failures.push('BROWSER_PAGE_ERROR'));
  page.on('response', (r) => {
    if (r.status() === 429) rateLimits.push(Date.now());
  });
  await page.goto(href);
  await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
    timeout: 30000,
  });
  const sentinel = 'Texte conservé après cinq minutes sans modification';
  await page.locator('.bn-editor[contenteditable="true"]').click();
  await page.keyboard.insertText(sentinel);
  const revision = async () =>
    String(
      (
        await pool.query('SELECT content_revision FROM collaboration_documents WHERE page_id=$1', [
          pageId,
        ])
      ).rows[0].content_revision,
    );
  await expect.poll(async () => Number(await revision())).toBeGreaterThan(0);
  await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
  await expect(page.getByRole('list', { name: 'Personnes connectées' }).locator('li')).toHaveCount(
    1,
  );
  assert.equal(page.context().pages().length, 1);
  const before = await revision();
  await page.evaluate(() => {
    const state = { statuses: [] as string[], alerts: [] as string[], hidden: false };
    const inspect = () => {
      const value = document.querySelector('[data-testid="save-status"]')?.textContent ?? '';
      if (state.statuses.at(-1) !== value) state.statuses.push(value);
      state.hidden ||= document.visibilityState !== 'visible';
      for (const el of Array.from(
        document.querySelectorAll('[role="alert"], [data-testid="local-save-status"]'),
      )) {
        const text = el.textContent?.trim() ?? '';
        const style = getComputedStyle(el);
        if (
          el.getBoundingClientRect().width &&
          style.visibility !== 'hidden' &&
          ((el.getAttribute('role') === 'alert' && text) || text.includes('indisponible')) &&
          !state.alerts.includes(text)
        )
          state.alerts.push(text);
      }
    };
    const observer = new MutationObserver(inspect);
    observer.observe(document.body, {
      subtree: true,
      childList: true,
      characterData: true,
      attributes: true,
    });
    const interval = setInterval(inspect, 1000);
    inspect();
    (window as typeof window & { memoriaIdleProbe?: () => typeof state }).memoriaIdleProbe = () => {
      observer.disconnect();
      clearInterval(interval);
      inspect();
      return state;
    };
  });
  const startedAt = Date.now();
  for (let i = 0; i < 10; i++) {
    await delay(30000);
    console.info('Idle front observation: ' + Math.round((Date.now() - startedAt) / 1000) + ' s');
  }
  await delay(5000);
  const finishedAt = Date.now();
  const visible = await page.evaluate(() =>
    (
      window as typeof window & {
        memoriaIdleProbe: () => { statuses: string[]; alerts: string[]; hidden: boolean };
      }
    ).memoriaIdleProbe(),
  );
  const during = events.filter((e) => e.at >= startedAt && e.at <= finishedAt);
  const after = await revision();
  const report = {
    date: new Date().toISOString(),
    scope:
      'One visible real Next.js editor, real Nest/PostgreSQL/WSS/Caddy; sentinel saved before observation, no input or reload during observation',
    startedAt,
    finishedAt,
    durationMs: finishedAt - startedAt,
    revisionBefore: before,
    revisionAfter: after,
    visible,
    failures,
    rateLimits,
    events: during,
    presenceFrames: during.filter((e) => e.kind === 'sent' && e.type === 1).length,
    receivedFrames: during.filter((e) => e.kind === 'received').length,
    closures: during.filter((e) => e.kind === 'close').length,
    openAtEnd: sockets.filter((s) => !s.isClosed()).length,
  };
  await writeFile(resolve(directory, 'idle-report.json'), JSON.stringify(report, null, 2) + '\n');
  assert(finishedAt - startedAt >= 305000);
  assert.equal(before, after, 'No content write during the idle interval');
  assert(!visible.hidden, 'The observed editor must remain visible');
  assert.deepEqual(failures, []);
  assert.deepEqual(rateLimits, []);
  assert.deepEqual(visible.alerts, []);
  assert(!visible.statuses.includes('Édition arrêtée'));
  assert(report.presenceFrames >= 15, 'Actual awareness refreshes must be sent');
  assert(report.receivedFrames >= 15, 'The real server must remain reachable');
  assert.equal(report.openAtEnd, 1);
  await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
  await expect(page.locator('.bn-editor')).toContainText(sentinel);
  await page.reload();
  await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
    timeout: 15000,
  });
  await expect(page.locator('.bn-editor')).toContainText(sentinel);
  await page.screenshot({ path: resolve(directory, 'idle-after-reload.png'), fullPage: true });
  console.info('PASS idle front; report ' + resolve(directory, 'idle-report.json'));
}
