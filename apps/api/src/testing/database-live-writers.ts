import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase } from '@memoria/db';
import { collaborationAccessSchema, collaborationRowAccessSchema } from '@memoria/contracts';
import { collaborationServer, sessionVerifier } from '../../../collab/src/service/server.ts';
import { readCollabConfig } from '../../../collab/src/service/config.ts';
import { nativeRowClient } from '../../../collab/src/testing/native-row-client.ts';
import { caddyFixture } from '../../../collab/src/testing/caddy-fixture.ts';
import { firstText, until } from '../../../collab/src/testing/pool-helpers.ts';
import { receiptFor } from '../../../collab/src/service/store.ts';
import type { databaseHttpHarness, Reader } from './database-http-fixture.ts';

/** Native HTTP tickets and real WSS; sampled lock waits are approximate (5ms polling). */
export async function databaseLiveWriters(
  h: Awaited<ReturnType<typeof databaseHttpHarness>>,
  reader: Reader,
  routes: string[],
) {
  const url = new URL(h.f.db.url);
  url.searchParams.set(
    'options',
    url.searchParams.get('options') + ' -c application_name=memoria_6d_wss',
  );
  const connection = createDatabase(url.toString());
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      COLLAB_HOST: '0.0.0.0',
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
    }),
    connection.pool,
    sessionVerifier(h.authentication),
  );
  process.env.COLLAB_INTERNAL_URL = host.internal.url;
  const proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
  const clients: Awaited<ReturnType<typeof nativeRowClient>>[] = [];
  let collecting = false,
    confirmations: number[] = [];
  const close = async () => {
    for (const c of clients) c.close();
    proxy.close();
    await host.close();
    await connection.pool.end();
  };
  try {
    for (const route of routes) {
      const response = await h.call(reader, {}, route + '/collaboration');
      const row = route.includes('/rows/');
      assert.equal(response.status, row ? 200 : 201);
      const meta = row
        ? collaborationRowAccessSchema.parse(response.data)
        : collaborationAccessSchema.parse(response.data);
      const token = row
        ? {
            ...meta.identity,
            scope: 'database-row',
            rowScope: collaborationRowAccessSchema.parse(response.data).rowScope,
          }
        : {
            ...meta.identity,
            scope: 'page',
            accessVersion: collaborationAccessSchema.parse(response.data).accessVersion,
          };
      const c = await nativeRowClient(
        proxy.url,
        proxy.ca,
        reader.cookie,
        h.config.APP_ORIGIN,
        meta.room,
        token,
      );
      assert(!c.closed());
      clients.push(c);
      const room = host.rooms.get(meta.room)!;
      const update = room.update.bind(room);
      room.update = async (...args: Parameters<typeof room.update>) => {
        const start = performance.now();
        const value = await update(...args);
        if (collecting) confirmations.push(performance.now() - start);
        return value;
      };
    }
    return {
      close,
      async run(work: () => Promise<void>, minimum = 30) {
        let stop = false,
          failure: unknown;
        collecting = true;
        confirmations = [];
        const wire: { start: number; end: number; ms: number }[] = [],
          waits: number[] = [];
        const pending = new Map<string, { first: number; last: number }>();
        const jobs = clients.map(async (c, index) => {
          await delay(index * 35);
          while (!stop) {
            const start = performance.now();
            let receipt = '';
            c.doc.once('update', (bytes: Uint8Array) => {
              receipt = receiptFor(bytes);
            });
            firstText(c.doc).insert(0, 'x');
            assert(receipt);
            await until(() => c.receiptTimes.has(receipt) || c.closed(), 'rights WSS receipt');
            assert(!c.closed(), 'Unrelated native editor disconnected');
            const end = c.receiptTimes.get(receipt)!;
            wire.push({ start, end, ms: end - start });
            await delay(Math.max(0, 200 - (performance.now() - start)));
          }
        });
        jobs.push(
          (async () => {
            while (!stop) {
              const now = performance.now();
              const activity = await h.f.db.pool.query<{ pid: number; query_start: Date }>(
                "SELECT pid,query_start FROM pg_stat_activity WHERE application_name='memoria_6d_wss' AND wait_event_type='Lock' AND query LIKE '%content_lock_document%'",
              );
              const current = new Set<string>();
              for (const r of activity.rows) {
                const key = r.pid + ':' + r.query_start.toISOString();
                current.add(key);
                pending.set(key, { first: pending.get(key)?.first ?? now, last: now });
              }
              for (const [key, wait] of pending)
                if (!current.has(key)) {
                  waits.push(wait.last - wait.first);
                  pending.delete(key);
                }
              await delay(5);
            }
          })(),
        );
        const done = Promise.all(jobs).catch((e: unknown) => {
          failure = e;
          stop = true;
        });
        try {
          await work();
        } finally {
          stop = true;
          await done;
          collecting = false;
        }
        if (failure) throw failure;
        for (const wait of pending.values()) waits.push(wait.last - wait.first);
        assert(wire.length >= minimum, 'Enough durable native WSS receipts');
        return { wire, waits, confirmations };
      },
    };
  } catch (e) {
    await close();
    throw e;
  }
}
