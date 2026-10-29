import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile } from 'node:fs/promises';
import type { PoolClient } from 'pg';
import * as Y from 'yjs';
import { FileBoundary } from '@memoria/db';
import { prepareMeasurement, runMeasuredSeries } from '../../../../scripts/measurement-memory.mjs';
import { testDatabase } from './database.ts';
import { loadProfile } from './profiles.ts';
import { decodeDocument } from '../codec.ts';
import { applyCommands } from '../service/commands.ts';
import { Store } from '../service/store.ts';
import { Leadership } from '../service/leadership.ts';
import { Room } from '../service/room.ts';
import { Projections } from '../service/projection.ts';

async function profile() {
  const db = await testDatabase(),
    leader = new Leadership(db.url, () => {});
  await leader.start();
  const store = new Store(db.pool, leader),
    doc = new Y.Doc();
  let room: Room | undefined, projection: Projections | undefined;
  try {
    doc.getXmlFragment('prosemirror');
    Y.applyUpdate(doc, await loadProfile('content-1M'));
    const image = decodeDocument(doc).find((b) => b.type === 'core.paragraph')!.id;
    applyCommands(doc, [
      {
        op: 'update',
        id: image,
        type: 'core.image',
        schemaVersion: 1,
        content: { fileId: null, alt: '', caption: '', width: 512 },
      },
    ]);
    const snapshot = Y.encodeStateAsUpdate(doc),
      businessBytes = Buffer.byteLength(JSON.stringify(decodeDocument(doc)));
    doc.destroy();
    await db.pool.query(
      'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
      [db.page, db.workspace, db.generation, Buffer.from(snapshot), snapshot.length, businessBytes],
    );
    const identity = { ...db, key: db.user },
      boundary = new FileBoundary(db.pool);
    const file = await boundary.reserve(identity, {
      bytes: 100,
      name: 'profile',
      idempotency: randomUUID(),
    });
    await db.pool.query("UPDATE files SET state='ready' WHERE id=$1", [file]);
    await db.pool.query(
      "UPDATE file_upload_intents SET attach_until=now()+interval '1 day' WHERE file_id=$1",
      [file],
    );
    room = new Room(store, db.page, db.generation, new Y.Doc(), () => {});
    projection = new Projections(store);
    await room.load();
    const client = new Y.Doc();
    client.getXmlFragment('prosemirror');
    Y.applyUpdate(client, snapshot);
    const vector = Y.encodeStateVector(client);
    applyCommands(client, [
      {
        op: 'update',
        id: image,
        schemaVersion: 1,
        content: { fileId: file, alt: '', caption: '', width: 512 },
      },
    ]);
    await room.update(identity, Y.encodeStateAsUpdate(client, vector));
    client.destroy();
    const calls: { statement: string; elapsed: number; end: number }[] = [];
    let firstReference: number | undefined,
      txStart = 0,
      txEnd = 0,
      referenceSql = '',
      referenceValues: unknown[] = [];
    const original = store.transaction.bind(store);
    store.transaction = async function <T>(
      work: (c: PoolClient) => Promise<T>,
      lock?: Parameters<Store['transaction']>[1],
    ): Promise<T> {
      txStart = performance.now();
      try {
        return await original(async (c) => {
          const traced = new Proxy(c, {
            get(target, property) {
              if (property !== 'query') return Reflect.get(target, property, target);
              return async (...args: unknown[]) => {
                const input = args[0] as string | { text: string };
                const sql = typeof input === 'string' ? input : input.text;
                const start = performance.now();
                const result = await Reflect.apply(target.query, target, args);
                const end = performance.now();
                calls.push({ statement: sql, elapsed: end - start, end });
                if (sql.startsWith('INSERT INTO file_references')) {
                  firstReference ??= end;
                  referenceSql = sql;
                  referenceValues = args[1] as unknown[];
                }
                return result;
              };
            },
          });
          return work(traced);
        }, lock);
      } finally {
        txEnd = performance.now();
      }
    };
    const ready = once(process, 'message');
    process.send?.({ kind: 'prepared' });
    const [message] = await ready;
    if (message.kind !== 'start') return;
    const start = performance.now();
    await projection.project(db.page, db.generation);
    const total = performance.now() - start;
    assert.equal(
      (await db.pool.query('SELECT projection_revision FROM collaboration_documents')).rows[0]
        .projection_revision,
      '1',
    );
    assert(firstReference);
    const groups: Record<string, { calls: number; milliseconds: number }> = {};
    for (const call of calls) {
      const label = call.statement.startsWith('INSERT INTO blocks')
        ? 'blocks'
        : call.statement.startsWith('INSERT INTO file_references')
          ? 'file_references'
          : call.statement.includes('search_documents')
            ? 'search'
            : call.statement.includes('audit_logs')
              ? 'audit'
              : call.statement.includes('outbox_events')
                ? 'outbox'
                : 'other';
      groups[label] ??= { calls: 0, milliseconds: 0 };
      groups[label]!.calls++;
      groups[label]!.milliseconds += call.elapsed;
    }
    // EXPLAIN uses the actual captured projection statement; rollback leaves no duplicate reference.
    const c = await db.pool.connect();
    let explain: unknown;
    try {
      await c.query('BEGIN');
      explain = (
        await c.query('EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ' + referenceSql, referenceValues)
      ).rows[0]['QUERY PLAN'];
      await c.query('ROLLBACK');
    } finally {
      c.release();
    }
    const report = {
      series: Number(process.env.MEMORIA_FILE_PROFILE_SERIES),
      projectionMs: total,
      transactionMs: txEnd - txStart,
      afterFirstFileFkMs: txEnd - firstReference,
      groups,
      explain,
      blockCount: 500,
      encodedBytes: snapshot.length,
      note: 'Real production projection, isolated schema; durations include PG network round trips. FK hold time is a lower bound from statement completion to transaction completion. EXPLAIN is separate and rolled back.',
    };
    process.send?.({ kind: 'result', report });
    console.log(JSON.stringify(report));
  } finally {
    doc.destroy();
    await projection?.close();
    await room?.close();
    await leader.close();
    await db.close();
  }
}
if (process.env.MEMORIA_FILE_PROFILE_SERIES) {
  try {
    await profile();
  } catch (error) {
    console.error(error);
    process.exitCode = 1;
  } finally {
    process.disconnect?.();
  }
} else {
  const reports: object[] = [];
  for (let series = 1; series <= 3; series++) {
    const label = `file-projection-${series}`,
      preparation = await prepareMeasurement(label);
    const child = fork(import.meta.filename, [], {
      env: { ...process.env, MEMORIA_FILE_PROFILE_SERIES: String(series) },
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
    });
    let closed = false,
      report: unknown;
    const ended = once(child, 'exit').then(([code]) => {
      closed = true;
      return code;
    });
    const prepared = new Promise<void>((resolve, reject) => {
      child.on('message', (m: { kind: string; report?: unknown }) => {
        if (m.kind === 'prepared') resolve();
        if (m.kind === 'result') report = m.report;
      });
      child.once('exit', () => reject(new Error('Profiling fixture exited')));
      child.once('error', reject);
    });
    try {
      await prepared;
      const { result, hygiene } = await runMeasuredSeries(
        label,
        async () => {
          child.send({ kind: 'start' });
          const code = await ended;
          return { code, report };
        },
        { preparation, maxAttempts: 1 },
      );
      reports.push({ series, result, hygiene });
      await writeFile(
        '.local/session-7-projection-profile.json',
        JSON.stringify({ date: new Date().toISOString(), reports }, null, 2) + '\n',
      );
      assert.equal(result.code, 0);
    } finally {
      if (!closed) {
        child.send({ kind: 'cancel' });
        const timer = setTimeout(() => child.kill(), 15000);
        await ended;
        clearTimeout(timer);
      }
    }
  }
}
