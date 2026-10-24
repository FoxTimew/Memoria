import { test } from 'node:test';
import { writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import assert from 'node:assert/strict';
import { loadProfile } from './profiles.ts';
import { testDatabase } from './database.ts';
import { decodeDocument } from '../codec.ts';
import { Leadership } from '../service/leadership.ts';
import { Store } from '../service/store.ts';
import { IncrementalValidator } from '../service/incremental-validator.ts';
test(
  'Production incremental validation and journal, 1 MiB profiles',
  { timeout: 120000 },
  async () => {
    const db = await testDatabase(),
      leader = new Leadership(db.url, () => {});
    await leader.start();
    const store = new Store(db.pool, leader),
      reports: object[] = [];
    try {
      for (const profile of ['content-1M', 'history-1M']) {
        const snapshot = await loadProfile(profile),
          generation = randomUUID();
        const doc = new Y.Doc();
        doc.getXmlFragment('prosemirror');
        Y.applyUpdate(doc, snapshot);
        await db.pool.query('DELETE FROM collaboration_documents WHERE page_id=$1', [db.page]);
        await db.pool.query(
          'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
          [
            db.page,
            db.workspace,
            generation,
            snapshot,
            snapshot.length,
            Buffer.byteLength(JSON.stringify(decodeDocument(doc))),
          ],
        );
        const replica = new IncrementalValidator(),
          samples: object[] = [];
        await replica.init(snapshot);
        const nodes = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)],
          texts = nodes.filter((n): n is Y.XmlText => n instanceof Y.XmlText),
          cards = nodes.filter(
            (n): n is Y.XmlElement =>
              n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
          );
        try {
          for (let i = 0; i < 220; i++) {
            let update!: Uint8Array;
            const capture = (u: Uint8Array) => {
              update = u;
            };
            doc.on('update', capture);
            doc.transact(() => {
              if (i % 4 === 0)
                cards[i % cards.length]!.setAttribute('health', (200 + i) as unknown as string);
              else if (i % 4 === 1) texts[i % texts.length]!.delete(0, 1);
              else texts[i % texts.length]!.insert(0, 'x');
            });
            doc.off('update', capture);
            const start = performance.now(),
              validated = await replica.prepare(update),
              validatedAt = performance.now();
            await store.append(
              generation,
              i,
              [{ identity: { ...db, key: db.user }, receipt: randomUUID(), update }],
              update,
              validated.blocks,
              validated.blockIdsToReserve,
            );
            const committedAt = performance.now();
            await replica.commit();
            if (i >= 20)
              samples.push({
                validation: validatedAt - start,
                transaction: committedAt - validatedAt,
                total: performance.now() - start,
              });
          }
          const totals = (samples as { total: number }[]).map((s) => s.total).sort((a, b) => a - b),
            p95 = totals[189]!;
          const preparedPlans = (
            await db.pool.query(
              'SELECT name,generic_plans,custom_plans FROM pg_prepared_statements ORDER BY name',
            )
          ).rows;
          const report = {
            profile,
            p95,
            max: totals.at(-1),
            iterations: 200,
            warmup: 20,
            preparedPlans,
            samples,
          };
          reports.push(report);
          console.log(JSON.stringify({ ...report, samples: 200 }));
        } finally {
          await replica.close();
          doc.destroy();
        }
      }
      await writeFile(
        '.local/3a-warm-production.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            scope:
              'Worker prepare + production fenced journal transaction including ID reservation + replica commit. No projection, socket, network or queue.',
            reports,
          },
          null,
          2,
        ),
      );
      for (const report of reports as { profile: string; p95: number }[])
        assert(report.p95 < 50, `${report.profile}: p95=${report.p95}`);
    } finally {
      await leader.close();
      await db.close();
    }
  },
);
