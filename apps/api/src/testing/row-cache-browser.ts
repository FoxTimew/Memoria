/// <reference lib="dom" />
import assert from 'node:assert/strict';
import { build } from 'esbuild';
import { chromium } from '@playwright/test';
import type { Page } from '@playwright/test';
import type {
  YjsCache,
  CacheTicket,
  CachePage,
  RowSnapshot,
  CachePolicy,
} from '../../../web/src/lib/yjs-cache.ts';
import type { databaseHttpFixture, Reader } from './database-http-fixture.ts';
type Harness = { store: YjsCache; ticket: CacheTicket; record: CachePage; update: Uint8Array };
declare global {
  interface Window {
    CacheLib: { YjsCache: typeof YjsCache };
    rowTest: Harness;
  }
}
/** Chromium IndexedDB, two same-origin tabs, and decisions returned by the real guarded HTTP route. */
export async function attackRowCache(
  h: Awaited<ReturnType<typeof databaseHttpFixture>>,
  account: Reader,
) {
  const asset = await build({
    entryPoints: ['apps/web/src/lib/yjs-cache.ts'],
    bundle: true,
    platform: 'browser',
    format: 'iife',
    globalName: 'CacheLib',
    write: false,
  });
  const browser = await chromium.launch({
      headless: true,
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
    }),
    context = await browser.newContext();
  const { f } = h,
    w = f.db.workspace,
    W = `/api/internal/workspaces/${w}`,
    request = {
      rows: [
        { database: f.bases[0]!, row: f.rows[0]! },
        { database: f.bases[0]!, row: f.rows[1]! },
      ],
    };
  const check = async () => {
    const r = await h.call(account, request, W + '/row-access');
    assert.equal(r.status, 200);
    return r.data as unknown as RowSnapshot;
  };
  const policyResponse = await h.call(account, {}, '/api/auth/security/cache-policy', {}, 'GET');
  assert.equal(policyResponse.status, 200, JSON.stringify(policyResponse.data));
  const policy = policyResponse.data as unknown as CachePolicy;
  const snapshot = await check();
  assert(snapshot.rows.every((r) => r.available));
  const init = async (page: Page, row: string) => {
    await page.goto(h.origin);
    await page.addScriptTag({ content: asset.outputFiles[0]!.text });
    await page.evaluate(
      async ({ u, s, w, row, policy, snapshot }) => {
        const store = new window.CacheLib.YjsCache();
        let ticket = await store.ticket(u, s);
        ticket = await store.applyPolicy(ticket, policy);
        ticket = await store.applyRowAccess(ticket, w, snapshot);
        const opened = await store.open(ticket, w, row, 'cache-test-generation');
        // Valid empty Yjs update. Persistence mechanism is independent of the content validator.
        const update = new Uint8Array([0, 0]);
        await store.append(ticket, opened.page, update, 'pending-test');
        window.rowTest = { store, ticket, record: opened.page, update };
      },
      { u: account.user, s: account.session, w, row, policy, snapshot },
    );
  };
  try {
    const asleep = await context.newPage(),
      awake = await context.newPage();
    await init(asleep, f.rows[0]!);
    await init(awake, f.rows[1]!);
    const old = await asleep.evaluate(() => window.rowTest.ticket);
    // No callbacks in the sleeping tab; only the other tab observes the real archival.
    const route = `${W}/databases/${f.bases[0]}/rows/${f.rows[0]}`;
    const current = await h.call(account, {}, route, {}, 'GET');
    assert.equal(current.status, 200);
    assert.equal(
      (await h.call(account, { expectedVersion: String(current.data.version) }, route + '/archive'))
        .status,
      200,
    );
    const denied = await check();
    assert.equal(denied.rows[0]!.available, false);
    assert.equal(denied.rows[1]!.available, true);
    await awake.evaluate(
      async ({ w, snapshot }) => {
        const f = window.rowTest;
        const before = await f.store.ticket(f.ticket.user, f.ticket.session);
        await f.store.applyRowAccess(before, w, snapshot);
      },
      { w, snapshot: denied },
    );
    const result = await asleep.evaluate(
      async ({ w, snapshot, old }) => {
        const f = window.rowTest;
        let append = false,
          open = false;
        try {
          await f.store.append(old, f.record, f.update, 'late');
          append = true;
        } catch {
          /* An old ticket must be rejected. */
        }
        try {
          const stale = await f.store.applyRowAccess(old, w, snapshot);
          await f.store.open(stale, w, f.record.page, f.record.generation);
          open = true;
        } catch {
          /* A delayed HTTP answer must not restore old bytes. */
        }
        return { append, open };
      },
      { w, snapshot, old },
    );
    assert.deepEqual(result, { append: false, open: false });
    assert.equal(
      await awake.evaluate(async () => {
        const f = window.rowTest;
        await f.store.append(f.ticket, f.record, f.update, 'still-allowed');
        return true;
      }),
      true,
    );
    const archived = await h.call(account, {}, `${W}/databases/${f.bases[0]}/trash`, {}, 'GET');
    const item = (archived.data.items as { id: string; version: string }[]).find(
      (r) => r.id === f.rows[0],
    )!;
    assert(item);
    assert.equal(
      (await h.call(account, { expectedVersion: item.version }, route + '/restore')).status,
      200,
    );
    const restored = await check();
    assert.equal(
      await asleep.evaluate(
        async ({ w, snapshot, policy }) => {
          const f = window.rowTest;
          const fresh = await f.store.applyRowAccess(
            await f.store.applyPolicy(
              await f.store.ticket(f.ticket.user, f.ticket.session),
              policy,
            ),
            w,
            snapshot,
          );
          return (await f.store.open(fresh, w, f.record.page, f.record.generation)).updates.length;
        },
        { w, snapshot: restored, policy },
      ),
      0,
    );
    await awake.evaluate(async () => {
      const f = window.rowTest;
      await f.store.clearUser(f.ticket.user, f.ticket.session);
    });
    assert.equal(
      await asleep.evaluate(async () => {
        const f = window.rowTest;
        try {
          await f.store.append(f.ticket, f.record, f.update, 'post-logout');
          return false;
        } catch {
          return (await f.store.pending(f.ticket.user)) === 0;
        }
      }),
      true,
    );
  } finally {
    await context.close();
    await browser.close();
  }
}
