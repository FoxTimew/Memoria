import { randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { cpus, platform, release } from 'node:os';
import assert from 'node:assert/strict';
import * as Y from 'yjs';
import { contentFixture } from './content-fixture.ts';
import { historyFixture } from './sized-fixture.ts';
import { IncrementalValidator } from './incremental-validator.ts';
import { proofDatabase } from './database.ts';
import { appendUpdate } from '../journal.ts';
import { decodeDocument } from '../codec.ts';
import { distribution } from './metrics.ts';

const reports = [];
const four = process.argv.includes('--four');
const profiles = four
  ? ['history-4M']
  : process.argv.includes('--fallback')
    ? ['history-512', 'history-256', 'history-192']
    : ['content-1M', 'history-1M', 'history-4M'];
await mkdir('.local/incremental', { recursive: true });
for (const name of profiles) {
  console.log(`INCREMENTAL preparing ${name}`);
  const target = name.endsWith('4M')
    ? 4 * 1024 ** 2 - 65536
    : name.endsWith('1M')
      ? 1024 ** 2 - 4096
      : Number(name.split('-')[1]) * 1024 - 4096;
  let fixture;
  if (four) {
    const prior = JSON.parse(await readFile('.local/incremental-performance.json', 'utf8')) as {
      reports: { name: string; profile: Awaited<ReturnType<typeof historyFixture>>['profile'] }[];
    };
    const doc = new Y.Doc();
    doc.getXmlFragment('prosemirror');
    Y.applyUpdate(doc, new Uint8Array(await readFile('.local/incremental/history-4M.bin')));
    fixture = { doc, profile: prior.reports.find((r) => r.name === name)!.profile };
  } else
    fixture = name.startsWith('content') ? await contentFixture() : await historyFixture(target);
  const snapshot = Y.encodeStateAsUpdate(fixture.doc);
  await writeFile(`.local/incremental/${name}.bin`, snapshot);
  const db = await proofDatabase(),
    validator = new IncrementalValidator(
      name.endsWith('4M') ? 10000 : 250,
      name.endsWith('4M') ? 512 : 128,
    );
  const coldStarted = performance.now();
  try {
    await validator.init(snapshot);
    const coldMs = performance.now() - coldStarted;
    await db.client.query(
      'INSERT INTO collaboration_documents(page_id,generation,snapshot) VALUES($1,$2,$3)',
      [db.page, randomUUID(), Buffer.from(snapshot)],
    );
    const nodes = [...fixture.doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
    const texts = nodes.filter((n): n is Y.XmlText => n instanceof Y.XmlText);
    const cards = nodes.filter(
      (n): n is Y.XmlElement => n instanceof Y.XmlElement && n.nodeName === 'gamedevCharacterCard',
    );
    const samples = [];
    let failure: string | undefined;
    for (let i = 0; i < 220; i++) {
      let update!: Uint8Array;
      const capture = (u: Uint8Array) => {
        update = u;
      };
      fixture.doc.on('update', capture);
      const kind = i % 4 === 0 ? 'character-field' : i % 4 === 1 ? 'deletion-only' : 'text';
      fixture.doc.transact(() => {
        if (kind === 'character-field')
          cards[i % cards.length]!.setAttribute('health', (200 + i) as unknown as string);
        else if (kind === 'deletion-only') texts[i % texts.length]!.delete(0, 1);
        else texts[i % texts.length]!.insert(0, 'x');
      });
      fixture.doc.off('update', capture);
      const started = performance.now();
      try {
        const validated = await validator.prepare(update),
          validatedAt = performance.now();
        await appendUpdate(db.client, db, randomUUID(), update, validated.blocks);
        const committedAt = performance.now();
        await validator.commit();
        const finished = performance.now();
        if (i >= 20)
          samples.push({
            kind,
            bytes: update.length,
            checkedBlocks: validated.checkedBlocks,
            jsonBytes: validated.jsonBytes,
            upperBound: validated.encodedUpperBound,
            validation: validated.validationMs,
            validationWithIsolation: validatedAt - started,
            transaction: committedAt - validatedAt,
            commitAck: finished - committedAt,
            total: finished - started,
          });
      } catch (error) {
        failure = error instanceof Error ? error.message : String(error);
        break;
      }
      if ((i + 1) % 20 === 0) console.log(`${name}: ${Math.max(0, i - 19)}/200 measured`);
    }
    let finalBytes: number | undefined;
    if (!failure) {
      const final = await validator.snapshot();
      finalBytes = final.length;
      const check = new Y.Doc();
      check.getXmlFragment('prosemirror');
      Y.applyUpdate(check, final);
      assert.deepEqual(decodeDocument(check), decodeDocument(fixture.doc));
      check.destroy();
    }
    const totals = samples.length ? distribution(samples.map((s) => s.total)) : undefined;
    const report = {
      name,
      profile: fixture.profile,
      coldMs,
      deadlineMs: name.endsWith('4M') ? 10000 : 250,
      workerMemoryMiB: name.endsWith('4M') ? 512 : 128,
      warmup: 20,
      iterations: samples.length,
      failure,
      finalBytes,
      passed: !failure && samples.length === 200 && totals!.p95 < 50,
      milliseconds: totals
        ? {
            validation: distribution(samples.map((s) => s.validation)),
            validationWithIsolation: distribution(samples.map((s) => s.validationWithIsolation)),
            transaction: distribution(samples.map((s) => s.transaction)),
            total: totals,
          }
        : undefined,
      samples,
    };
    reports.push(report);
    console.log(
      JSON.stringify({ ...report, samples: `${samples.length} unfiltered samples saved` }, null, 2),
    );
    await writeFile(
      four
        ? '.local/incremental-four.json'
        : process.argv.includes('--fallback')
          ? '.local/incremental-fallback.json'
          : '.local/incremental-performance.json',
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
            'Persistent isolated replica prepare + SQL transaction + replica commit acknowledgement; excludes cold load, room queue, network and projection. No full snapshot on hot path.',
          reports,
        },
        null,
        2,
      ),
    );
    if (!report.passed && !name.endsWith('4M')) {
      console.log('TARGET FAILED: stop implementation; measure fallback sizes only.');
      process.exitCode = 2;
      if (!process.argv.includes('--fallback')) break;
    }
  } finally {
    await validator.close();
    fixture.doc.destroy();
    await db.close();
  }
}
