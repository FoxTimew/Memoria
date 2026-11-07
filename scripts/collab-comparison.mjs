import { assessRegression } from './measurement-regression.mjs';

export function summarizeComparison(series, suites, profiles) {
  const metrics = {},
    supplementaryMetrics = {},
    failures = [];
  for (const suite of suites) {
    const supplementary = suite === 'cold-lifecycle';
    const names = supplementary
      ? profiles.flatMap((profile) =>
          ['empty-pool', 'ready-pool'].map((phase) => `${profile}:${phase}`),
        )
      : profiles;
    for (const profile of names) {
      const key = `${suite}:${profile}`,
        metric = {};
      const ceiling = suite === 'warm' ? (profile === 'content-1M' ? 50 : 100) : 500;
      for (const configuration of ['reference', 'candidate']) {
        const rows = series.filter((s) => s.suite === suite && s.configuration === configuration);
        const values = rows.map((s) => s.p95[profile]);
        if (
          values.length !== 3 ||
          new Set(rows.map((s) => s.iteration)).size !== 3 ||
          values.some((v) => !Number.isFinite(v))
        )
          throw new Error('Three complete distinct series required');
        const median = [...values].sort((a, b) => a - b)[1];
        metric[configuration] = { values, median };
        if (suite === 'warm' && profile === 'history-1M' ? median > ceiling : median >= ceiling)
          failures.push(`${configuration} ${key}: median ${median} outside ${ceiling} ms`);
      }
      Object.assign(metric, assessRegression(metric.reference.median, metric.candidate.median));
      metric.pairedChangePercent = metric.candidate.values.map(
        (v, i) => (v / metric.reference.values[i] - 1) * 100,
      );
      if (metric.exceedsRegression)
        failures.push(
          `${key}: regression ${metric.changeMs.toFixed(3)} ms > allowance ${metric.allowedRegressionMs.toFixed(3)} ms (max of 10% or 2 ms)`,
        );
      (supplementary ? supplementaryMetrics : metrics)[key] = metric;
    }
  }
  return { metrics, supplementaryMetrics, failures };
}
