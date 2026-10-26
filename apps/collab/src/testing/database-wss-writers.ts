import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import pg from 'pg';
import WebSocket from 'ws';
import * as Y from 'yjs';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { resolvePageAccess } from '@memoria/db';
import type { PageAccessRequest } from '@memoria/db';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { receiptFor } from '../service/store.ts';
import { testAuth } from './auth.ts';
import type { TestDatabase } from './database.ts';
import { caddyFixture } from './caddy-fixture.ts';
import { firstText, until } from './pool-helpers.ts';

/** Real auth, TLS/Caddy, Hocuspocus and durable receipts. The row-scope adapter exists only
 * in this isolated fixture: production still rejects legacy page tokens for database rows. */
export async function databaseWssWriters(db: TestDatabase, bases: string[]) {
  const authentication = await testAuth(db),
    account = await authentication.account('WSS measure');
  // Replace, rather than add to, the fixture's owner: exactly 100 memberships throughout measurement.
  await db.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
    db.workspace,
    db.user,
  ]);
  await db.pool.query(
    "UPDATE workspace_members SET role='owner' WHERE workspace_id=$1 AND user_id=$2",
    [db.workspace, account.user],
  );
  const url = new URL(db.url);
  url.searchParams.set(
    'options',
    url.searchParams.get('options') + ' -c application_name=memoria_6a_wss',
  );
  const pool = new pg.Pool({ connectionString: url.toString(), max: 8, pipeline: true });
  const scopes = new Map<string, NonNullable<PageAccessRequest['rowScope']>>();
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      DATABASE_URL: db.url,
      COLLAB_HOST: '0.0.0.0',
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
      COLLAB_VALIDATION_WORKERS: '2',
      COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
    }),
    pool,
    sessionVerifier(authentication.auth),
    {
      access: (connection, requests) =>
        resolvePageAccess(
          connection,
          requests.map((r) => (scopes.has(r.page) ? { ...r, rowScope: scopes.get(r.page)! } : r)),
        ),
    },
  );
  let proxy: Awaited<ReturnType<typeof caddyFixture>> | undefined,
    collecting = false;
  let confirmations: number[] = [];
  const peers: {
    doc: Y.Doc;
    provider: HocuspocusProvider;
    socket: HocuspocusProviderWebsocket;
    pending: Map<
      string,
      { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
    >;
    failed: () => boolean;
  }[] = [];
  const close = async () => {
    for (const p of peers) {
      for (const r of p.pending.values()) {
        clearTimeout(r.timer);
        r.reject(new Error('CLOSED'));
      }
      p.provider.destroy();
      p.socket.destroy();
      p.doc.destroy();
    }
    proxy?.close();
    await host.close();
    await pool.end();
    await authentication.pool.end();
  };
  try {
    proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
    for (let i = 0; i < 4; i++) {
      const row =
        i === 3
          ? null
          : (
              await db.pool.query(
                `SELECT r.page_id,r.lifecycle_version,d.id AS database,a.version FROM database_rows r JOIN databases d ON d.id=r.database_id
      JOIN workspace_members m ON m.workspace_id=r.workspace_id AND m.user_id=$2
      JOIN page_access_state a ON a.workspace_id=r.workspace_id AND a.member_id=m.id AND a.page_id=d.page_id
      WHERE r.database_id=$1 ORDER BY r.page_id LIMIT 1`,
                [bases[i], account.user],
              )
            ).rows[0];
      const page = row?.page_id ?? db.page;
      if (row)
        scopes.set(page, {
          database: row.database,
          baseVersion: row.version,
          lifecycle: row.lifecycle_version,
        });
      const identity = {
        key: 'wss-' + i,
        user: account.user,
        session: account.session,
        workspace: db.workspace,
        page,
        ...(row ? { rowScope: scopes.get(page)! } : {}),
      };
      const state = await host.store.open(identity),
        doc = new Y.Doc();
      const pending = new Map<
        string,
        { resolve: () => void; reject: (e: Error) => void; timer: ReturnType<typeof setTimeout> }
      >();
      let failed = false;
      const socket = new HocuspocusProviderWebsocket({
        url: proxy.url,
        autoConnect: false,
        maxAttempts: 1,
        WebSocketPolyfill: class extends WebSocket {
          constructor(address: string) {
            super(address, {
              ca: proxy!.ca,
              headers: { cookie: account.cookie, origin: authentication.origin },
            });
          }
        },
      });
      const name = `${db.workspace}:${page}:${state.generation}`;
      const provider = new HocuspocusProvider({
        name,
        document: doc,
        websocketProvider: socket,
        awareness: null,
        token: '',
        onAuthenticationFailed: () => {
          failed = true;
        },
        onClose: () => {
          failed = true;
        },
        onStateless: ({ payload }) => {
          const receipt = JSON.parse(payload);
          if (
            receipt.status === 'durable' &&
            receipt.kind !== 'sync' &&
            receipt.generation === state.generation
          ) {
            const p = pending.get(receipt.receipt);
            if (p) {
              pending.delete(receipt.receipt);
              clearTimeout(p.timer);
              p.resolve();
            }
          }
        },
      });
      peers.push({ doc, provider, socket, pending, failed: () => failed });
      provider.attach();
      void socket.connect();
      await until(() => provider.synced || failed, 'TLS editor sync');
      assert(!failed, 'TLS editor authenticated');
      const room = host.rooms.get(name)!;
      const update = room.update.bind(room);
      // Timing wrapper delegates the complete production method without replacing its behavior.
      room.update = async (...args: Parameters<typeof update>) => {
        const start = performance.now();
        const receipt = await update(...args);
        if (collecting) confirmations.push(performance.now() - start);
        return receipt;
      };
    }
    assert.equal(
      (
        await db.pool.query('SELECT count(*) n FROM workspace_members WHERE workspace_id=$1', [
          db.workspace,
        ])
      ).rows[0].n,
      '100',
    );
    return {
      metadata: {
        transport: 'WSS via isolated Caddy, certificate and hostname verified',
        caddyImage: proxy.image,
        rowScope:
          'fixture-owned, frozen base/lifecycle epochs; production row ticket route not exposed',
      },
      async run(work: () => Promise<void>) {
        let stopped = false;
        collecting = true;
        confirmations = [];
        const roundTrips: number[] = [],
          waits: number[] = [],
          pending = new Map<string, { first: number; last: number }>();
        const writers = peers.map(async (p, i) => {
          await delay(i * 40);
          while (!stopped) {
            assert(!p.failed(), 'WebSocket unexpectedly closed');
            const start = performance.now();
            const receipt = new Promise<void>((resolve, reject) => {
              p.doc.once('update', (bytes: Uint8Array) => {
                const key = receiptFor(bytes);
                const timer = setTimeout(() => {
                  p.pending.delete(key);
                  reject(new Error('Durable receipt timeout'));
                }, 5000);
                p.pending.set(key, { resolve, reject, timer });
              });
            });
            firstText(p.doc).insert(0, 'x');
            await receipt;
            roundTrips.push(performance.now() - start);
            await delay(Math.max(0, 200 - (performance.now() - start)));
          }
        });
        const sampler = (async () => {
          while (!stopped) {
            const now = performance.now();
            const result = await db.pool.query<{ pid: number; query_start: Date }>(
              "SELECT pid,query_start FROM pg_stat_activity WHERE application_name='memoria_6a_wss' AND wait_event_type='Lock' AND query LIKE '%content_lock_document%'",
            );
            const active = new Set<string>();
            for (const r of result.rows) {
              const key = r.pid + ':' + r.query_start.toISOString();
              active.add(key);
              const old = pending.get(key);
              pending.set(key, { first: old?.first ?? now, last: now });
            }
            for (const [key, t] of pending)
              if (!active.has(key)) {
                waits.push(t.last - t.first);
                pending.delete(key);
              }
            await delay(5);
          }
        })();
        // Attach rejection handlers immediately, including if work() is still running.
        let failure: unknown;
        const done = Promise.all([...writers, sampler]).catch((e) => {
          failure = e;
          stopped = true;
        });
        try {
          await work();
        } finally {
          stopped = true;
          await done;
          collecting = false;
        }
        if (failure) throw failure;
        for (const t of pending.values()) waits.push(t.last - t.first);
        const allWaits = [
          ...waits,
          ...Array.from({ length: Math.max(0, confirmations.length - waits.length) }, () => 0),
        ];
        assert(roundTrips.length >= 30, 'At least 30 complete WSS receipts per series');
        return { confirmations, waits, allWaits, roundTrips };
      },
      close,
    };
  } catch (e) {
    await close();
    throw e;
  }
}
