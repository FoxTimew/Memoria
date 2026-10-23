import { randomUUID } from 'node:crypto';
import { cpus, platform, release } from 'node:os';
import { writeFile } from 'node:fs/promises';
import * as Y from 'yjs';
import { representativeDocument } from './fixture.ts';
import { proofDatabase } from './database.ts';
import { CandidateValidator } from '../validator.ts';
import { appendUpdate } from '../journal.ts';
import { decodeDocument } from '../codec.ts';

const distribution = (samples: number[]) => {
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => Number(sorted[Math.ceil(p * sorted.length) - 1]!.toFixed(3));
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
};

export async function performanceGate() {
  const { doc } = await representativeDocument();
  const db = await proofDatabase();
  const validator = new CandidateValidator(new URL('./validation-worker.mjs', import.meta.url));
  try {
    await validator.ready();
    let snapshot = Y.encodeStateAsUpdate(doc);
    const initial = decodeDocument(doc);
    if (initial.length !== 300) throw new Error('Representative fixture must contain 300 blocks');
    await db.client.query(
      'INSERT INTO collaboration_documents(page_id,generation,snapshot) VALUES ($1,$2,$3)',
      [db.page, randomUUID(), Buffer.from(snapshot)],
    );
    const nodes = [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
    const texts = nodes.filter((node): node is Y.XmlText => node instanceof Y.XmlText);
    const cards = nodes.filter(
      (node): node is Y.XmlElement =>
        node instanceof Y.XmlElement && node.nodeName === 'gamedevCharacterCard',
    );
    const warmup = 20,
      iterations = 200;
    const samples: {
      validation: number;
      validationWithIsolation: number;
      transaction: number;
      total: number;
      bytes: number;
      kind: string;
    }[] = [];
    for (let i = 0; i < warmup + iterations; i++) {
      let update: Uint8Array | undefined;
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
      if (!update) throw new Error('No update generated');
      const started = performance.now();
      const validated = await validator.validate(snapshot, update);
      const validatedAt = performance.now();
      await appendUpdate(db.client, db, randomUUID(), update, validated.blocks);
      const committedAt = performance.now();
      snapshot = validated.snapshot;
      if (i >= warmup)
        samples.push({
          validation: validated.validationMs,
          validationWithIsolation: validatedAt - started,
          transaction: committedAt - validatedAt,
          total: committedAt - started,
          bytes: update.byteLength,
          kind,
        });
    }
    const settings = await db.client.query(
      "SELECT version(), current_setting('fsync') AS fsync, current_setting('synchronous_commit') AS synchronous_commit",
    );
    const totals = distribution(samples.map((s) => s.total));
    const report = {
      date: new Date().toISOString(),
      scope:
        'Full candidate clone + strict raw Yjs codec + Zod in isolated worker, page lock + current SQL rights + durable journal commit. Excludes WebSocket/auth handshake, room queue wait and projection.',
      environment: {
        node: process.version,
        os: `${platform()} ${release()}`,
        cpu: cpus()[0]?.model,
        postgres: settings.rows[0],
        yjs: '13.6.33',
        blocknote: '0.56.0',
      },
      fixture: {
        blocks: initial.length,
        nestingDepth: 3,
        characterCards: cards.length,
        types: [...new Set(initial.map((b) => b.type))],
        businessBytes: Buffer.byteLength(JSON.stringify(initial)),
        initialYjsBytes: (
          await db.client.query(
            'SELECT octet_length(snapshot) AS size FROM collaboration_documents',
          )
        ).rows[0].size as number,
        finalYjsBytes: snapshot.length,
      },
      warmup,
      iterations,
      milliseconds: {
        candidate: distribution(samples.map((s) => s.validation)),
        candidateWithIsolation: distribution(samples.map((s) => s.validationWithIsolation)),
        transaction: distribution(samples.map((s) => s.transaction)),
        total: totals,
      },
      passed: totals.p95 < 50,
      samples,
    };
    await writeFile(
      new URL('../../../.local/session-3-performance.json', import.meta.url),
      JSON.stringify(report, null, 2),
    );
    console.log(
      JSON.stringify(
        {
          ...report,
          samples: `${samples.length} unfiltered samples in .local/session-3-performance.json`,
        },
        null,
        2,
      ),
    );
    if (!report.passed)
      throw new Error(
        'PERFORMANCE GATE FAILED: p95 >= 50 ms. STOP; incremental validation requires approval.',
      );
    console.log('PERFORMANCE GATE PASSED (p95 < 50 ms).');
    return report;
  } finally {
    await validator.close();
    doc.destroy();
    await db.close();
  }
}

await performanceGate();
