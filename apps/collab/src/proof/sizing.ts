import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import * as Y from 'yjs';
import { historyFixture } from './sized-fixture.ts';
import { proofDatabase } from './database.ts';
import { CandidateValidator } from '../validator.ts';
import { appendUpdate } from '../journal.ts';
import { distribution } from './metrics.ts';

const reports = [];
for (const target of process.argv.includes('--small')
  ? [192 * 1024]
  : [192 * 1024, 256 * 1024, 1024 ** 2, 4 * 1024 ** 2]) {
  console.log(`SIZE: preparing ${target} byte profile (up to 12 KiB headroom)`);
  const { doc, profile } = await historyFixture(target - 4096);
  const db = await proofDatabase();
  // Measure completed work even when it exceeds the normal 250 ms deadline.
  // These diagnostic allowances are never used by proofServer.
  const budget =
    target <= 192 * 1024
      ? { milliseconds: 250, memoryMiB: 128 }
      : { milliseconds: 10000, memoryMiB: 512 };
  const validator = new CandidateValidator(
    new URL('./validation-worker.mjs', import.meta.url),
    budget,
  );
  const admission = new CandidateValidator(new URL('./validation-worker.mjs', import.meta.url));
  try {
    await Promise.all([validator.ready(), admission.ready()]);
    let snapshot = Y.encodeStateAsUpdate(doc);
    await db.client.query(
      'INSERT INTO collaboration_documents(page_id,generation,snapshot) VALUES ($1,$2,$3)',
      [db.page, randomUUID(), Buffer.from(snapshot)],
    );
    const nodes = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
    const texts = nodes.filter((n): n is Y.XmlText => n instanceof Y.XmlText);
    const cards = nodes.filter(
      (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
    );
    const samples = [];
    let normalBudgetResult = '';
    for (let i = 0; i < 220; i++) {
      let update!: Uint8Array;
      const capture = (value: Uint8Array) => {
        update = value;
      };
      doc.on('update', capture);
      const kind = i % 4 === 0 ? 'character-field' : i % 4 === 1 ? 'deletion-only' : 'text';
      doc.transact(() => {
        if (kind === 'character-field')
          cards[i % cards.length]!.setAttribute('health', (200 + i) as unknown as string);
        else if (kind === 'deletion-only') texts[i % texts.length]!.delete(0, 1);
        else texts[i % texts.length]!.insert(0, 'x');
      });
      doc.off('update', capture);
      if (i === 0) {
        try {
          await admission.validate(snapshot, update);
          normalBudgetResult = 'completed within default 250 ms / 128 MiB on first update';
        } catch (error) {
          normalBudgetResult = error instanceof Error ? error.message : 'failed';
        }
        await admission.close();
        console.log(`SIZE ${target}: default budget: ${normalBudgetResult}`);
      }
      const started = performance.now();
      const validated = await validator.validate(snapshot, update);
      const validatedAt = performance.now();
      await appendUpdate(db.client, db, randomUUID(), update, validated.blocks);
      const committedAt = performance.now();
      snapshot = validated.snapshot;
      if (i >= 20)
        samples.push({
          kind,
          bytes: update.length,
          validation: validated.validationMs,
          validationWithIsolation: validatedAt - started,
          transaction: committedAt - validatedAt,
          total: committedAt - started,
          snapshotBytes: snapshot.length,
        });
      if ((i + 1) % 20 === 0)
        console.log(
          `SIZE ${target}: ${Math.max(0, i - 19)}/200 measured updates; latest ${(committedAt - started).toFixed(2)} ms`,
        );
    }
    const report = {
      target,
      profile,
      diagnosticBudget: budget,
      normalBudgetResult,
      warmup: 20,
      iterations: 200,
      finalBytes: snapshot.length,
      milliseconds: {
        validation: distribution(samples.map((s) => s.validation)),
        validationWithIsolation: distribution(samples.map((s) => s.validationWithIsolation)),
        transaction: distribution(samples.map((s) => s.transaction)),
        total: distribution(samples.map((s) => s.total)),
      },
      samples,
    };
    reports.push(report);
    console.log(
      JSON.stringify({ ...report, samples: `${samples.length} raw samples in report` }, null, 2),
    );
    await writeFile(
      process.argv.includes('--small')
        ? '.local/session-3-2bis-small.json'
        : '.local/session-3-2bis-size.json',
      JSON.stringify(
        {
          date: new Date().toISOString(),
          environment: {
            node: process.version,
            os: `${platform()} ${release()}`,
            cpu: cpus()[0]?.model,
            postgres: (
              await db.client.query(
                "SELECT version(),current_setting('fsync') AS fsync,current_setting('synchronous_commit') AS synchronous_commit",
              )
            ).rows[0],
          },
          scope:
            'Clone/full codec/Zod/encode in diagnostic worker + real page-locked durable transaction. No WebSocket/queue/projection. Unfiltered samples. Default budget checked separately.',
          reports,
        },
        null,
        2,
      ),
    );
  } finally {
    await validator.close();
    await admission.close();
    doc.destroy();
    await db.close();
  }
}
console.log('SIZE MEASUREMENTS COMPLETE; >=50 ms requires a product decision before integration.');
