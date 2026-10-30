import assert from 'node:assert/strict';
import { mkdir, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import {
  imageFixture,
  decodeFixture,
  imageId,
  startImageConverter,
  closeImageConverter,
} from './file-image-fixture.mjs';
import { prepareMeasurement, runMeasuredSeries } from './measurement-memory.mjs';
const reports = [];
const directory = resolve(
  '.local/7d-images-measurement-' + new Date().toISOString().replaceAll(':', '-'),
);
await mkdir(directory, { recursive: true });
const p95 = (v) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1];
const save = () =>
  writeFile(
    resolve(directory, 'measurement.json'),
    JSON.stringify(
      {
        image: imageId(),
        sampleCountPerSeries: 10,
        reports,
        threshold: { memoryBytes: 512 * 1024 ** 2, decodeSeconds: 30, concurrency: 1, cpu: 1 },
      },
      null,
      2,
    ) + '\n',
  );
try {
  const preparation = await prepareMeasurement('files-images-8k');
  const fixture = await imageFixture(true);
  await startImageConverter();
  for (let series = 1; series <= 3; series++) {
    for (const profile of ['solid', 'noise']) {
      const check = await prepareMeasurement(`files-images-${profile}-${series}`);
      const measured = await runMeasuredSeries(
        `files-images-${profile}-${series}`,
        async () => {
          const results = [];
          for (let i = 0; i < 10; i++) {
            let sample;
            try {
              sample = await decodeFixture(fixture + '/' + profile + '.png');
            } catch (error) {
              reports.push({ series, profile, error: error.message, details: error.details });
              await save();
              throw error;
            }
            results.push(sample);
            if (
              sample.status !== 'validated' ||
              sample.preview !== 'available' ||
              sample.elapsedMs >= 30000 ||
              sample.cgroupPeakBytes > 512 * 1024 ** 2
            ) {
              reports.push({ series, profile, results, stopped: true });
              await save();
              throw Error('IMAGE_LIMIT_EXCEEDED_STOP');
            }
            assert(sample.variants[0].width === 2048 && sample.variants[1].width === 512);
          }
          return {
            sourceBytes: (await stat(fixture + '/' + profile + '.png')).size,
            results,
            p95ElapsedMs: p95(results.map((r) => r.elapsedMs)),
            p95DecodeEncodeMs: p95(results.map((r) => r.decodeAndEncodeMs)),
            p95WallMs: p95(results.map((r) => r.wallMs)),
            maxCgroupBytes: Math.max(...results.map((r) => r.cgroupPeakBytes)),
            maxRssKiB: Math.max(...results.map((r) => r.maxRssKiB)),
          };
        },
        { preparation: check.path },
      );
      reports.push({ series, profile, initialPreparation: preparation.path, ...measured });
      await save();
      console.log(
        JSON.stringify({
          series,
          profile,
          p95ElapsedMs: measured.result.p95ElapsedMs,
          maxCgroupBytes: measured.result.maxCgroupBytes,
          directory,
        }),
      );
    }
  }
} catch (error) {
  await save();
  console.error(JSON.stringify({ error: error.message, directory, details: error.details }));
  process.exitCode = 1;
}

await closeImageConverter();
