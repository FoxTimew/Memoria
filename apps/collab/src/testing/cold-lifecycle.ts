// Explicit comparison entry only. Supplement to cold.e2e.ts, never a replacement.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { loadProfile } from './profiles.ts';
import { decodeDocument } from '../codec.ts';
import { readCollabConfig } from '../service/config.ts';
import { collaborationServer } from '../service/server.ts';
import { assertMemoryStage, readMemorySnapshot } from '../../../../scripts/measurement-memory.mjs';

type Host = Awaited<ReturnType<typeof collaborationServer>>;
async function evicted(host: Host) {
  const deadline = Date.now() + 3000;
  while ((host.memory.reservedBytes || host.rooms.size) && Date.now() < deadline) await delay(10);
  assert.equal(host.memory.reservedBytes, 0);
  assert.equal(host.rooms.size, 0);
  assert(host.validators.stats.every((slot) => slot.replicas === 0 && slot.waiting === 0));
}
async function open(host: Host, name: string) {
  const start = performance.now();
  const release = await host.memory.acquire(name);
  try {
    await host.hocus.createDocument(name, new Request('https://localhost'), randomUUID(), {
      readOnly: false,
      isAuthenticated: true,
    });
    return performance.now() - start;
  } finally {
    release();
  }
}

test(
  'Cold lifecycle: empty pool versus ready pool, fresh replica every time',
  { timeout: 180000 },
  async () => {
    // Requiring the guarded runner prevents an accidental unguarded performance run.
    assert.equal(process.env.COLLAB_MEASURE_HYGIENE, 'true');
    const db = await testDatabase();
    const reports: {
      profile: string;
      memoryAfterPreparation: ReturnType<typeof readMemorySnapshot>;
      encodedBytes: number;
      workers: number;
      warmup: number;
      iterations: number;
      samples: number[];
      p95: number;
      max: number;
    }[] = [];
    const trials: object[] = [];
    try {
      const config = readCollabConfig({
        ...process.env,
        DATABASE_URL: db.url,
        COLLAB_PORT: '0',
        COLLAB_INTERNAL_PORT: '0',
        COLLAB_REPLICA_IDLE_MS: '10',
      });
      for (const profile of ['content-1M', 'history-1M']) {
        const snapshot = await loadProfile(profile);
        const doc = new Y.Doc();
        doc.getXmlFragment('prosemirror');
        Y.applyUpdate(doc, snapshot);
        const business = Buffer.byteLength(JSON.stringify(decodeDocument(doc)));
        doc.destroy();
        assert(snapshot.length <= 1024 ** 2 && snapshot.length >= 1024 ** 2 - 8192);
        const generation = randomUUID(),
          name = `${db.workspace}:${db.page}:${generation}`;
        await db.pool.query('DELETE FROM collaboration_documents WHERE page_id=$1', [db.page]);
        await db.pool.query(
          'INSERT INTO collaboration_documents(workspace_id,page_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
          [db.workspace, db.page, generation, Buffer.from(snapshot), snapshot.length, business],
        );
        const memory = readMemorySnapshot();
        assertMemoryStage(memory, 'after-preparation');
        const values: Record<string, number[]> = { 'empty-pool': [], 'ready-pool': [] };
        for (let iteration = 0; iteration < 32; iteration++) {
          const host = await collaborationServer(config, db.pool, async () => {
            throw new Error('No session in cold-load measurement');
          });
          try {
            assert.equal(host.validators.stats.length, 0);
            assert.equal(host.rooms.size, 0);
            const emptyPool = await open(host, name);
            assert.equal(host.validators.stats.length, 1);
            await evicted(host);
            // Warm only the remaining workers, without loading a document or forcing GC.
            // A metrics response proves module initialization, unlike merely allocating a slot.
            while (host.validators.stats.length < config.COLLAB_VALIDATION_WORKERS) {
              const lease = host.validators.allocate();
              try {
                await lease.request('metrics', { collect: false }, 30000);
              } finally {
                await lease.close();
              }
            }
            assert.equal(host.validators.stats.length, config.COLLAB_VALIDATION_WORKERS);
            const workers = host.validators.stats.map((slot) => slot.id);
            await evicted(host);
            const readyPool = await open(host, name);
            assert.deepEqual(
              host.validators.stats.map((slot) => slot.id),
              workers,
            );
            await evicted(host);
            trials.push({
              profile,
              iteration,
              warmup: iteration < 2,
              emptyPool,
              readyPool,
              workers: workers.length,
            });
            if (iteration >= 2) {
              values['empty-pool']!.push(emptyPool);
              values['ready-pool']!.push(readyPool);
            }
          } finally {
            await host.close();
          }
        }
        for (const [phase, samples] of Object.entries(values)) {
          assert.equal(samples.length, 30);
          const sorted = [...samples].sort((a, b) => a - b);
          reports.push({
            profile: `${profile}:${phase}`,
            memoryAfterPreparation: memory,
            encodedBytes: snapshot.length,
            workers: config.COLLAB_VALIDATION_WORKERS,
            warmup: 2,
            iterations: 30,
            samples,
            p95: sorted[28]!,
            max: sorted[29]!,
          });
        }
      }
    } finally {
      await mkdir('.local', { recursive: true });
      await writeFile(
        '.local/3a-cold-lifecycle-production.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            scope:
              'Supplementary complete room opens: empty pool starts one lazy worker; ready pool has all workers initialized and no resident replicas. Fresh host per pair; host startup, pool priming and teardown are outside timing. No forced GC, network, authentication or concurrent typing. Does not replace the unchanged legacy cold measurement. Do not subtract independent p95s.',
            reports,
            trials,
          },
          null,
          2,
        ) + '\n',
      );
      await db.close();
    }
    assert.equal(reports.length, 4);
    for (const report of reports) {
      console.log(JSON.stringify(report));
      assert(report.p95 < 500, `${report.profile}: p95=${report.p95} ms`);
    }
  },
);
