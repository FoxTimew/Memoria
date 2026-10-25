import { test } from 'node:test';
import assert from 'node:assert/strict';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { representativeDocument } from './fixture.ts';
import { historyFixture } from './sized-fixture.ts';
import { firstText, peer, seedPage, until } from './pool-helpers.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { IncrementalValidator } from '../service/incremental-validator.ts';
import { emptyDocument } from '../service/commands.ts';

async function content() {
  const { doc } = await representativeDocument(300, 1);
  const cards = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].filter(
    (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
  );
  for (const card of cards) {
    const gap = 170 * 1024 - Y.encodeStateAsUpdate(doc).length - 256;
    if (gap > 0)
      card.setAttribute(
        'biography',
        'x'.repeat(Math.min(4990, gap + String(card.getAttribute('biography')).length)),
      );
  }
  return doc;
}

test(
  'Default 1 GiB budget holds thirty authenticated pages per typical profile',
  { timeout: 120000 },
  async () => {
    const freeBytes = freemem();
    console.log(JSON.stringify({ event: 'capacity.memory.before', freeBytes }));
    assert(
      freeBytes >= 3 * 1024 ** 3,
      'STOP: free RAM below 3 GiB; ask developer before measuring',
    );
    assert(global.gc, 'Capacity retained-memory measurement requires --expose-gc');
    const reports: object[] = [];
    for (const profile of ['content-200K', 'history-200K']) {
      const db = await testDatabase(),
        authentication = await testAuth(db);
      const accounts = [
        await authentication.account('Capacity A'),
        await authentication.account('Capacity B'),
      ];
      const host = await collaborationServer(
        readCollabConfig({
          ...process.env,
          DATABASE_URL: db.url,
          COLLAB_PORT: '0',
          COLLAB_INTERNAL_PORT: '0',
          COLLAB_REPLICA_MEMORY_BYTES: String(1024 ** 3),
        }),
        db.pool,
        sessionVerifier(authentication.auth),
      );
      const peers: ReturnType<typeof peer>[] = [],
        pages: Awaited<ReturnType<typeof seedPage>>[] = [];
      let peakRss = process.memoryUsage().rss;
      const samplePeak = () => {
        peakRss = Math.max(peakRss, process.memoryUsage().rss);
      };
      const timer = setInterval(samplePeak, 25);
      try {
        // Start every worker before taking the empty-pool baseline.
        const empty = emptyDocument(),
          warmups = Array.from(
            { length: host.validators.size },
            () => new IncrementalValidator(host.validators),
          );
        await Promise.all(warmups.map((v) => v.init(Y.encodeStateAsUpdate(empty))));
        await Promise.all(warmups.map((v) => v.close()));
        empty.destroy();
        const baselineWorkers = await host.validators.sample(true);
        global.gc();
        const baseline = process.memoryUsage();
        const fixture =
          profile === 'content-200K' ? await content() : (await historyFixture(170 * 1024)).doc;
        const source = Y.encodeStateAsUpdate(fixture);
        fixture.destroy();
        for (let i = 0; i < 30; i++) {
          const page = await seedPage(db, source);
          pages.push(page);
          assert(page.bytes <= 200 * 1024, `Typical page too large: ${page.bytes}`);
          const client = peer(host.ingress.url, page.name, accounts[i % 2]!.cookie);
          peers.push(client);
          await until(() => client.provider.synced, 'typical page synced');
          samplePeak();
        }
        assert.equal(host.connections.size, 30);
        assert.equal(host.rooms.size, 30);
        assert(host.memory.chargedBytes <= 1024 ** 3);
        assert(host.validators.stats.every((s) => s.replicas > 1));
        const loadedWorkers = await host.validators.sample(true);
        global.gc();
        const loaded = process.memoryUsage();
        // All thirty remain open during typing and automatic projection/compaction.
        for (const client of peers) firstText(client.doc).insert(0, 'Capacity test ');
        await until(
          () => peers.every((p) => p.receipts.length === 1),
          'thirty durable confirmations',
        );
        await until(
          async () =>
            Number(
              (
                await db.pool.query(
                  'SELECT count(*) AS n FROM collaboration_documents WHERE page_id=ANY($1::uuid[]) AND content_revision=1 AND projection_revision=1',
                  [pages.map((p) => p.page)],
                )
              ).rows[0].n,
            ) === 30,
          'thirty automatic projections',
          60000,
        );
        assert(peers.every((p) => !p.closed));
        assert.equal(host.rooms.size, 30);
        samplePeak();
        const afterWorkers = await host.validators.sample(true);
        global.gc();
        const after = process.memoryUsage();
        const replicaHeap =
          loadedWorkers.reduce((sum, m) => sum + m.heapUsed + m.external, 0) -
          baselineWorkers.reduce((sum, m) => sum + m.heapUsed + m.external, 0);
        const report = {
          profile,
          pages: 30,
          authenticatedSockets: host.connections.size,
          encodedBytes: pages.map((p) => p.bytes),
          businessBytes: pages.map((p) => p.business),
          workerCount: host.validators.size,
          workerDistribution: host.validators.stats,
          reservedBytes: host.memory.reservedBytes,
          fixedBytes: host.memory.fixedBytes,
          chargedBytes: host.memory.chargedBytes,
          baseline,
          loaded,
          after,
          peakRss,
          processLifetimePeakRss: process.resourceUsage().maxRSS * 1024,
          baselineWorkers,
          loadedWorkers,
          afterWorkers,
          replicaHeapPerPage: replicaHeap / 30,
          replicaExpansion: replicaHeap / pages.reduce((sum, p) => sum + p.bytes, 0),
          allPagesWrittenAndProjected: true,
        };
        reports.push(report);
        console.log(JSON.stringify(report));
      } finally {
        clearInterval(timer);
        peers.forEach((p) => p.destroy());
        await host.close();
        await authentication.pool.end();
        await db.close();
      }
    }
    await writeFile(
      '.local/3d-capacity-production.json',
      JSON.stringify(
        {
          date: new Date().toISOString(),
          freeBytes,
          scope:
            'Thirty real WebSocket providers with two Better Auth accounts, production SQL/server/workers. Same-process clients, fixture generator and auth are included in RSS/main heap. Retained heaps after explicit diagnostic GC; 25ms RSS sampling can miss short peaks. No full-stack or 50-account qualification.',
          reports,
        },
        null,
        2,
      ),
    );
  },
);
