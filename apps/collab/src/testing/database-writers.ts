import * as Y from 'yjs';
import pg from 'pg';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestDatabase } from './database.ts';
import { Leadership } from '../service/leadership.ts';
import { Store } from '../service/store.ts';
import { Room } from '../service/room.ts';
import { ValidationPool } from '../service/validation-pool.ts';
import { firstText } from './pool-helpers.ts';

/** Actual Room validation + Store journal; transport is deliberately excluded from this first SQL gate. */
export async function databaseWriters(db: TestDatabase, bases: string[]) {
  const url = new URL(db.url);
  url.searchParams.set(
    'options',
    url.searchParams.get('options') + ' -c application_name=memoria_6a_writers',
  );
  const pool = new pg.Pool({ connectionString: url.toString(), max: 4, pipeline: true });
  const leader = new Leadership(db.url, () => {}),
    validators = new ValidationPool(2);
  await leader.start();
  const store = new Store(pool, leader);
  const rooms: {
    room: Room;
    source: Y.Doc;
    identity: {
      key: string;
      user: string;
      session: string;
      workspace: string;
      page: string;
      rowScope?: { database: string };
    };
  }[] = [];
  try {
    for (let i = 0; i < 4; i++) {
      const page =
        i === 3
          ? db.page
          : (
              await db.pool.query(
                'SELECT page_id FROM database_rows WHERE database_id=$1 ORDER BY page_id LIMIT 1',
                [bases[i]],
              )
            ).rows[0].page_id;
      const identity = {
        key: 'writer' + i,
        user: db.user,
        session: db.session,
        workspace: db.workspace,
        page,
        ...(i === 3 ? {} : { rowScope: { database: bases[i]! } }),
      };
      const state = await store.open(identity),
        doc = new Y.Doc();
      const room = new Room(store, page, state.generation, doc, () => {}, validators);
      await room.load();
      const source = new Y.Doc();
      source.getXmlFragment('prosemirror');
      Y.applyUpdate(source, Y.encodeStateAsUpdate(doc));
      rooms.push({ room, source, identity });
    }
    return {
      async run(work: () => Promise<void>) {
        let stopped = false;
        const confirmations: number[] = [],
          waits: number[] = [];
        const pending = new Map<string, { first: number; last: number }>();
        const writers = rooms.map(async ({ room, source, identity }, i) => {
          await delay(i * 40);
          while (!stopped) {
            const start = performance.now();
            let update: Uint8Array | undefined;
            source.once('update', (bytes: Uint8Array) => {
              update = bytes;
            });
            firstText(source).insert(0, 'x');
            await room.update(identity, update!);
            confirmations.push(performance.now() - start);
            await delay(Math.max(0, 200 - (performance.now() - start)));
          }
        });
        const sampler = (async () => {
          while (!stopped) {
            const now = performance.now();
            const result = await db.pool.query<{ pid: number; query_start: Date }>(
              "SELECT pid,query_start FROM pg_stat_activity WHERE application_name='memoria_6a_writers' AND wait_event_type='Lock'",
            );
            const active = new Set<string>();
            for (const r of result.rows) {
              const key = r.pid + ':' + r.query_start.toISOString();
              active.add(key);
              const prior = pending.get(key);
              pending.set(key, { first: prior?.first ?? now, last: now });
            }
            for (const [key, times] of pending)
              if (!active.has(key)) {
                waits.push(times.last - times.first);
                pending.delete(key);
              }
            await delay(5);
          }
        })();
        try {
          await work();
        } finally {
          stopped = true;
          await Promise.all([...writers, sampler]);
        }
        for (const times of pending.values()) waits.push(times.last - times.first);
        // Zero for writes with no observed lock wait. Sampling underestimates waits by <= two poll intervals.
        const allWaits = [
          ...waits,
          ...Array.from({ length: Math.max(0, confirmations.length - waits.length) }, () => 0),
        ];
        return { confirmations, waits, allWaits };
      },
      async close() {
        for (const { room, source } of rooms) {
          await room.close();
          room.doc.destroy();
          source.destroy();
        }
        await validators.close();
        await leader.close();
        await pool.end();
      },
    };
  } catch (e) {
    for (const { room, source } of rooms) {
      await room.close();
      room.doc.destroy();
      source.destroy();
    }
    await validators.close();
    await leader.close();
    await pool.end();
    throw e;
  }
}
