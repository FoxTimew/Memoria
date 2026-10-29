import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { gunzipSync } from 'node:zlib';

const path = process.argv[2] ?? '.local/session-7-files-trace-measurement.json';
const bytes = await readFile(path);
const input = JSON.parse((path.endsWith('.gz') ? gunzipSync(bytes) : bytes).toString('utf8'));
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.ceil(values.length * q) - 1];
const keys = [
  'wireMs',
  'editMs',
  'beforeSendMs',
  'transitMs',
  'receiptHandlingMs',
  'accessAndDispatchMs',
  'queueMs',
  'reservationMs',
  'validationMs',
  'sqlMs',
  'replicaAndApplyMs',
  'diffusionAndReceiptMs',
  'serverResidenceMs',
  'transportAndSchedulingMs',
];
const groups = new Map();
for (const report of input.reports) {
  assert.equal(report.code, 0, 'Do not summarize incomplete or failed series as qualified');
  for (const result of report.results) {
    assert(result.paired.length === 100 * result.authors);
    for (const sample of result.paired) {
      for (const key of keys) assert(Number.isFinite(sample[key]), key);
      const sum = sample.beforeSendMs + sample.transitMs + sample.receiptHandlingMs;
      assert(Math.abs(sum - sample.wireMs) < 0.001, 'Client intervals must partition the receipt');
      const server = keys.slice(5, 12).reduce((n, key) => n + sample[key], 0);
      assert(
        Math.abs(server - sample.serverResidenceMs) < 0.001,
        'Server intervals must partition residence',
      );
    }
    const id = `${result.profile}/${result.references ? 'references' : 'text'}/${result.authors}`;
    const group = groups.get(id) ?? [];
    group.push({
      series: result.series,
      p95: Object.fromEntries(
        keys.map((key) => [
          key,
          quantile(
            result.paired.map((s) => s[key]),
            0.95,
          ),
        ]),
      ),
      receiptAtP95: [...result.paired].sort((a, b) => a.wireMs - b.wireMs)[
        Math.ceil(result.paired.length * 0.95) - 1
      ],
    });
    groups.set(id, group);
  }
}
console.log(
  JSON.stringify(
    {
      source: path,
      scope:
        'Per-process durations only. Edit CPU overlaps beforeSend/transit. Residual includes network, Caddy and OS/event-loop scheduling. Never add independent p95 values.',
      complete:
        [...groups.values()].length === 8 && [...groups.values()].every((g) => g.length === 3),
      groups: [...groups].map(([scenario, series]) => ({
        scenario,
        series,
        medianOfThreeP95:
          series.length === 3
            ? Object.fromEntries(
                keys.map((key) => [
                  key,
                  quantile(
                    series.map((s) => s.p95[key]),
                    0.5,
                  ),
                ]),
              )
            : null,
      })),
    },
    null,
    2,
  ),
);
