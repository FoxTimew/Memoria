import assert from 'node:assert/strict';
import { readFile, mkdtemp, unlink } from 'node:fs/promises';
import { resolve, join } from 'node:path';
import { chromium, expect } from '@playwright/test';

/** Isolated browser only. Playwright normally forces focus/visibility on every page,
 * making Page.setWebLifecycleState a silent no-op. Own this override so freeze is real. */
export async function lifecycleBrowser() {
  const server = await chromium.launchServer({
    channel: process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
    headless: true,
    args: ['--remote-debugging-port=0'],
  });
  try {
    const profile = server
      .process()
      .spawnargs.find((arg) => arg.startsWith('--user-data-dir='))
      .slice('--user-data-dir='.length);
    const [port] = (await readFile(`${profile}/DevToolsActivePort`, 'utf8')).split('\n');
    const browser = await chromium.connectOverCDP(`http://127.0.0.1:${port}`, { noDefaults: true });
    const context = browser.contexts()[0],
      sessions = new Map();
    return {
      browser,
      context,
      async download(action) {
        // noDefaults also leaves downloads at the browser default. Configure only
        // this isolated default context and observe the actual completed file via CDP.
        const directory = await mkdtemp(resolve('.local/browser-download-'));
        const cdp = await browser.newBrowserCDPSession();
        await cdp.send('Browser.setDownloadBehavior', {
          behavior: 'allowAndName',
          downloadPath: directory,
          eventsEnabled: true,
        });
        let timer;
        try {
          const completed = new Promise((resolve, reject) => {
            timer = globalThis.setTimeout(
              () => reject(new Error('Download did not complete')),
              15000,
            );
            cdp.on('Browser.downloadProgress', (event) => {
              if (event.state === 'completed') resolve(event.guid);
              if (event.state === 'canceled') reject(new Error('Download canceled'));
            });
          });
          // Start awaiting before clicking: a rejected action must not leave a dangling promise.
          const [guid] = await Promise.all([completed, action()]);
          const path = join(directory, guid);
          const contents = await readFile(path, 'utf8');
          await unlink(path);
          return contents;
        } finally {
          globalThis.clearTimeout(timer);
          await cdp.detach();
        }
      },
      async page() {
        const page = await context.newPage();
        await page.setViewportSize({ width: 1440, height: 1100 });
        const cdp = await context.newCDPSession(page);
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
        sessions.set(page, cdp);
        return page;
      },
      async freeze(page) {
        const cdp = sessions.get(page);
        await page.evaluate(() => {
          globalThis.__lifecycleProof = { freezes: 0, resumes: 0, ticks: 0 };
          globalThis.document.addEventListener(
            'freeze',
            () => globalThis.__lifecycleProof.freezes++,
          );
          globalThis.document.addEventListener(
            'resume',
            () => globalThis.__lifecycleProof.resumes++,
          );
          globalThis.__lifecycleTimer = globalThis.setInterval(
            () => globalThis.__lifecycleProof.ticks++,
            10,
          );
        });
        await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: false });
        const foreground = await context.newPage();
        await foreground.bringToFront();
        await expect.poll(() => page.evaluate(() => globalThis.document.hidden)).toBe(true);
        await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
        const before = await page.evaluate(() => globalThis.__lifecycleProof);
        assert(before.freezes > 0, 'The browser must emit a real freeze event');
        await new Promise((resolve) => globalThis.setTimeout(resolve, 150));
        assert.equal(
          await page.evaluate(() => globalThis.__lifecycleProof.ticks),
          before.ticks,
          'Timers must really be suspended',
        );
        return async () => {
          await cdp.send('Page.setWebLifecycleState', { state: 'active' });
          await page.bringToFront();
          await foreground.close();
          await cdp.send('Emulation.setFocusEmulationEnabled', { enabled: true });
          await expect
            .poll(() => page.evaluate(() => globalThis.__lifecycleProof.resumes))
            .toBeGreaterThan(0);
          await page.evaluate(() => globalThis.clearInterval(globalThis.__lifecycleTimer));
          console.log('PASS real browser freeze/resume events and suspended timer');
        };
      },
      async close() {
        try {
          await browser.close();
        } finally {
          await server.close();
        }
      },
    };
  } catch (error) {
    await server.close();
    throw error;
  }
}
