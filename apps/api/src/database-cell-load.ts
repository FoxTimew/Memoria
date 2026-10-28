import 'reflect-metadata';
import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { collaborationRowAccessSchema } from '@memoria/contracts';
import { prepareMeasurement, runMeasuredSeries } from '../../../scripts/measurement-memory.mjs';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { nativeRowClient } from '../../collab/src/testing/native-row-client.ts';
import { caddyFixture } from '../../collab/src/testing/caddy-fixture.ts';
import { firstText, until } from '../../collab/src/testing/pool-helpers.ts';
import { receiptFor } from '../../collab/src/service/store.ts';
import { databaseEventWorker } from './testing/database-event-worker.ts';

const p95 = (xs: number[]) => [...xs].sort((a, b) => a - b)[Math.ceil(xs.length * 0.95) - 1] ?? 0;
const preparation = await prepareMeasurement('database-http-cells');
const h = await databaseHttpFixture(),
  { f } = h;
const readers = [await h.account('owner'), await h.account('member')];
const host = await collaborationServer(
  readCollabConfig({
    ...process.env,
    COLLAB_HOST: '0.0.0.0',
    COLLAB_PORT: '0',
    COLLAB_INTERNAL_PORT: '0',
  }),
  f.db.pool,
  sessionVerifier(h.authentication),
);
process.env.COLLAB_INTERNAL_URL = host.internal.url;
const proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
const clients: Awaited<ReturnType<typeof nativeRowClient>>[] = [];
const events = databaseEventWorker(f.db.pool);
const reports: unknown[] = [];
const B = `/api/internal/workspaces/${f.db.workspace}/databases/${f.bases[0]}`;
const R = B + '/rows/' + f.rows[0];
const versions = ['0', '0'];
const save = () =>
  writeFile(
    '.local/session-6d-http-cells.json',
    JSON.stringify(
      {
        protocol:
          'Three series, two real authenticated HTTP cell writers and two native WSS writers on the same row; 100 scalar + 100 set writes, then 30 conflicting pairs. HTTP guard/quotas/admission/serialization included. Cells paced 650ms per writer, Yjs paced 200ms; no counter resets. WSS latency ends at receipt arrival, not polling wakeup.',
        preparation,
        reports,
      },
      null,
      2,
    ) + '\n',
  );
try {
  for (const reader of readers) {
    const r = await h.call(reader, {}, R + '/collaboration');
    assert.equal(r.status, 200);
    const meta = collaborationRowAccessSchema.parse(r.data);
    const c = await nativeRowClient(
      proxy.url,
      proxy.ca,
      reader.cookie,
      h.config.APP_ORIGIN,
      meta.room,
      { ...meta.identity, scope: 'database-row', rowScope: meta.rowScope },
    );
    assert(!c.closed());
    clients.push(c);
  }
  for (let series = 1; series <= 3; series++) {
    const eventStart = events.count();
    const { result, hygiene } = await runMeasuredSeries(
      `database-http-cells-${series}`,
      async () => {
        const samples: {
            kind: string;
            conflict: boolean;
            status: number;
            server: number;
            roundTrip: number;
          }[] = [],
          wire: number[] = [];
        let stop = false,
          conflict = false,
          failure: string | null = null;
        const editors = clients
          .map(async (c, index) => {
            while (!stop) {
              const start = performance.now();
              let update: Uint8Array | undefined;
              c.doc.once('update', (bytes: Uint8Array) => {
                update = bytes;
              });
              firstText(c.doc).insert(firstText(c.doc).length, String(index));
              assert(update);
              const receipt = receiptFor(update);
              await until(() => c.receiptTimes.has(receipt) || c.closed(), 'cell load WSS receipt');
              assert(!c.closed());
              wire.push(c.receiptTimes.get(receipt)! - start);
              await delay(Math.max(0, 200 - (performance.now() - start)));
            }
          })
          .map((work) =>
            work.catch((e: unknown) => {
              stop = true;
              failure = e instanceof Error ? e.message : String(e);
            }),
          );
        const patch = async (
          index: number,
          kind: 'text' | 'multi_select',
          version: string,
          value: unknown,
        ) => {
          const r = await h.call(
            readers[index],
            { expectedSchemaVersion: '1', expectedCellVersion: version, value },
            `${R}/cells/${f.properties[kind]}`,
            {},
            'PATCH',
          );
          samples.push({
            kind,
            conflict,
            status: r.status,
            server: r.server,
            roundTrip: r.roundTrip,
          });
          return r;
        };
        try {
          await Promise.all(
            readers.map(async (_, index) => {
              for (let n = 0; n < 100; n++) {
                assert(!failure, failure ?? '');
                const start = performance.now();
                const r = await patch(
                  index,
                  index ? 'multi_select' : 'text',
                  versions[index]!,
                  index ? [f.options.multi_select![n % 2]] : `${series}-${n}`,
                );
                assert.equal(r.status, 200);
                versions[index] = String(r.data.version);
                await delay(Math.max(0, 650 - (performance.now() - start)));
              }
            }),
          );
          conflict = true;
          for (let n = 0; n < 30; n++) {
            assert(!failure, failure ?? '');
            const start = performance.now();
            const pair = await Promise.all(
              readers.map((_, index) => patch(index, 'text', versions[0]!, 'race')),
            );
            assert.deepEqual(pair.map((r) => r.status).sort(), [200, 409]);
            versions[0] = String(pair.find((r) => r.status === 200)!.data.version);
            await delay(Math.max(0, 650 - (performance.now() - start)));
          }
        } catch (e) {
          failure = e instanceof Error ? e.message : String(e);
        } finally {
          stop = true;
          await Promise.all(editors);
        }
        await until(
          () => firstText(clients[0]!.doc).toString() === firstText(clients[1]!.doc).toString(),
          'two native writers converge',
        );
        const values = ['text', 'multi_select'].map((kind) =>
          p95(
            samples
              .filter((s) => !s.conflict && s.kind === kind && s.status === 200)
              .map((s) => s.server),
          ),
        );
        return { failure, samples, wire, p95: values, wireP95: p95(wire) };
      },
      { preparation },
    );
    events.check();
    reports.push({ series, hygiene, ...result, aggregatedEvents: events.count() - eventStart });
    await save();
    console.log(
      JSON.stringify({
        series,
        p95: result.p95,
        wireP95: result.wireP95,
        receipts: result.wire.length,
        failure: result.failure,
      }),
    );
    assert(!result.failure, result.failure ?? '');
    assert(
      result.p95.every((v) => v < 100),
      'STOP_HTTP_CELL_P95',
    );
    assert(result.wireP95 < 200, 'STOP_WSS_CONFIRMATION_P95');
  }
} finally {
  for (const c of clients) c.close();
  proxy.close();
  await host.close();
  await events.close();
  await h.close();
}
