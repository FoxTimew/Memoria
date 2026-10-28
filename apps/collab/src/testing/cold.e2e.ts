import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { loadProfile } from './profiles.ts';
import { decodeDocument } from '../codec.ts';
import { readCollabConfig } from '../service/config.ts';
import { collaborationServer } from '../service/server.ts';
import { readMemorySnapshot, assertMemoryStage } from '../../../../scripts/measurement-memory.mjs';
test(
  'Cold production load, 1 MiB content/history, 30 unfiltered samples each',
  { timeout: 120000 },
  async () => {
    const db = await testDatabase(),
      reports: object[] = [];
    const host = await collaborationServer(
      readCollabConfig({
        ...process.env,
        DATABASE_URL: db.url,
        COLLAB_PORT: '0',
        COLLAB_INTERNAL_PORT: '0',
        COLLAB_REPLICA_IDLE_MS: '10',
      }),
      db.pool,
      async () => {
        throw new Error('No session in cold-load measurement');
      },
    );
    try {
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
        const samples: number[] = [];
        const memory =
          process.env.COLLAB_MEASURE_HYGIENE === 'true' ? readMemorySnapshot() : undefined;
        if (memory) assertMemoryStage(memory, 'after-preparation');
        for (let i = 0; i < 32; i++) {
          const start = performance.now(),
            release = await host.memory.acquire(name);
          try {
            await host.hocus.createDocument(name, new Request('https://localhost'), randomUUID(), {
              readOnly: false,
              isAuthenticated: true,
            });
            if (i >= 2) samples.push(performance.now() - start);
          } finally {
            release();
          }
          const end = Date.now() + 3000;
          while (host.memory.reservedBytes && Date.now() < end) await delay(10);
          assert.equal(host.memory.reservedBytes, 0);
        }
        const sorted = [...samples].sort((a, b) => a - b),
          p95 = sorted[Math.ceil(samples.length * 0.95) - 1]!;
        const report = {
          profile,
          memoryAfterPreparation: memory,
          encodedBytes: snapshot.length,
          businessBytes: business,
          warmup: 2,
          iterations: 30,
          p95,
          max: sorted.at(-1),
          samples,
        };
        reports.push(report);
        if (profile === 'history-1M') {
          await host.projections.project(db.page, generation);
          const metrics = (
            await db.pool.query(
              'SELECT encoded_bytes,business_bytes,history_ratio,history_warning_at FROM collaboration_documents WHERE page_id=$1',
              [db.page],
            )
          ).rows[0];
          assert(metrics.history_warning_at);
          assert(Number(metrics.history_ratio) >= 4);
          assert.equal(metrics.encoded_bytes, snapshot.length);
        }
        console.log(JSON.stringify(report));
      }
      await mkdir('.local', { recursive: true });
      await writeFile(
        '.local/3a-cold-production.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            scope:
              'Real Hocuspocus cold room: memory admission, consistent PostgreSQL snapshot read, live Yjs document and fresh replica in the shared pool (worker processes can be reused). No journal tail, session check, network or concurrent typing.',
            reports,
          },
          null,
          2,
        ),
      );
      for (const report of reports as { profile: string; p95: number }[])
        assert(report.p95 < 500, `${report.profile}: p95=${report.p95} ms`);
    } finally {
      await host.close();
      await db.close();
    }
  },
);
