import { expect, it } from 'vitest';
import { summarizeComparison } from './collab-comparison.mjs';

const fixture = () =>
  ['warm', 'cold', 'cold-lifecycle'].flatMap((suite) =>
    ['reference', 'candidate'].flatMap((configuration) =>
      [1, 2, 3].map((iteration) => ({
        suite,
        configuration,
        iteration,
        p95:
          suite === 'cold-lifecycle'
            ? {
                'content-1M:empty-pool': 150,
                'content-1M:ready-pool': 45,
                'history-1M:empty-pool': 300,
                'history-1M:ready-pool': 240,
              }
            : {
                'content-1M': suite === 'warm' ? 10 : 150,
                'history-1M':
                  suite === 'warm' ? 35 : configuration === 'reference' ? 240.685 : 272.246,
              },
      })),
    ),
  );
const summarize = (rows) =>
  summarizeComparison(rows, ['warm', 'cold', 'cold-lifecycle'], ['content-1M', 'history-1M']);
it('keeps the existing historical regression red even when all supplementary opens pass', () => {
  const result = summarize(fixture());
  expect(Object.keys(result.metrics)).toHaveLength(4);
  expect(Object.keys(result.supplementaryMetrics)).toHaveLength(4);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain('cold:history-1M: regression');
});
it('enforces the absolute cold ceiling for supplementary opens too', () => {
  const rows = fixture();
  rows
    .filter((s) => s.suite === 'cold-lifecycle' && s.configuration === 'candidate')
    .forEach((s) => {
      s.p95['history-1M:empty-pool'] = 500;
    });
  expect(
    summarize(rows).failures.some((f) => f.includes('cold-lifecycle:history-1M:empty-pool')),
  ).toBe(true);
});
it('does not qualify an empty-pool regression when the four original metrics pass', () => {
  const rows = fixture();
  for (const row of rows) {
    if (row.suite === 'cold') row.p95['history-1M'] = 240.685;
    if (row.suite === 'cold-lifecycle')
      row.p95['content-1M:empty-pool'] = row.configuration === 'reference' ? 156.168 : 187.0014;
  }
  const result = summarize(rows);
  expect(result.failures).toHaveLength(1);
  expect(result.failures[0]).toContain('cold-lifecycle:content-1M:empty-pool: regression');
});
it('refuses missing, duplicated or nonfinite samples rather than selecting successful series', () => {
  const rows = fixture();
  expect(() => summarize(rows.slice(1))).toThrow('Three complete distinct series required');
  rows[0].iteration = rows[1].iteration;
  expect(() => summarize(rows)).toThrow('Three complete distinct series required');
  const invalid = fixture();
  invalid[0].p95['content-1M'] = NaN;
  expect(() => summarize(invalid)).toThrow('Three complete distinct series required');
});
