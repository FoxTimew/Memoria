import { readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const directory = resolve(process.argv[2] ?? '.local/isolation');
const read = async (name) => JSON.parse(await readFile(resolve(directory, name + '.json'), 'utf8'));
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const cold = await read('cold');
const capacity = await read('capacity');
const mixed = await read('mixed');
const rows = mixed.reports.map((run) => {
  const r = run.result.results?.[0];
  return {
    profile: run.profile,
    series: run.series,
    conversions: run.conversions,
    code: run.result.code,
    primary: r?.perPage?.[0]?.p95,
    typical: r?.perPage?.slice(1).map((page) => ({ index: page.index, ...page.p95 })),
    maximumTypicalP95: r?.perPage?.length
      ? Object.fromEntries(
          ['server', 'transaction', 'wire', 'otherClient'].map((key) => [
            key,
            Math.max(...r.perPage.slice(1).map((page) => page.p95[key])),
          ]),
        )
      : null,
    converged: r?.converged,
    measuredContributions: r?.samples?.length,
    closures: r?.lifecycle?.filter((client) => client.closed || client.failed),
    conversionsDone: r?.conversionsDone?.map((conversion) => ({
      profile: conversion.profile,
      decodeAndEncodeMs: conversion.decodeAndEncodeMs,
      wallMs: conversion.wallMs,
      cgroupPeakBytes: conversion.cgroupPeakBytes,
    })),
    memory: r?.isolation,
    hygiene: run.hygiene?.assessment,
  };
});
const groups = [...new Set(rows.map((r) => r.profile + ':' + r.conversions))].map((key) => {
  const runs = rows.filter((r) => r.profile + ':' + r.conversions === key);
  return {
    key,
    series: runs.length,
    primary: Object.fromEntries(
      ['server', 'transaction', 'wire', 'otherClient'].map((metric) => {
        const values = runs.map((run) => run.primary?.[metric]).filter((v) => v !== undefined);
        return [metric, { values, median: median(values) }];
      }),
    ),
    maximumTypicalP95: Object.fromEntries(
      ['server', 'wire', 'otherClient'].map((metric) => {
        const values = runs
          .map((run) => run.maximumTypicalP95?.[metric])
          .filter((v) => v !== undefined);
        return [metric, { values, median: median(values) }];
      }),
    ),
  };
});
const allRuns = [...cold.reports, ...capacity.reports, ...mixed.reports];
const hygiene = {
  series: allRuns.length,
  allValid: allRuns.every((r) => r.hygiene?.assessment?.valid === true),
  intervals: allRuns.reduce((sum, r) => sum + (r.hygiene?.assessment?.intervals ?? 0), 0),
  minimumWindowsAfterPreparationGiB:
    Math.min(...allRuns.map((r) => r.hygiene.before.windowsFreeBytes)) / 1024 ** 3,
  minimumWslAfterPreparationGiB:
    Math.min(...allRuns.map((r) => r.hygiene.before.wsl.memAvailableBytes)) / 1024 ** 3,
};
const summary = {
  generatedAt: new Date().toISOString(),
  scope:
    'Limited publication-isolation proof. Not integrated, no alternate comparison with main, no true-front CPU saturation qualification.',
  cold: cold.reports.map((r) => ({
    series: r.series,
    code: r.result.code,
    ...r.result.report.reports[0],
    samples: undefined,
  })),
  capacity: capacity.reports.map((r) => {
    const p = r.result.report.reports[0];
    return {
      profile: p.profile,
      series: r.series,
      code: r.result.code,
      pages: p.pages,
      authenticatedSockets: p.authenticatedSockets,
      chargedBytes: p.chargedBytes,
      fixedBytes: p.fixedBytes,
      peakRss: p.peakRss,
      processLifetimePeakRss: p.processLifetimePeakRss,
      publicationBaseline: p.publicationBaseline,
      publication: p.publication,
      workerDistribution: p.workerDistribution,
    };
  }),
  mixed: { groups, rows },
  hygiene,
};
await writeFile(resolve(directory, 'summary.json'), JSON.stringify(summary, null, 2) + '\n');
console.log(
  JSON.stringify(
    {
      cold: summary.cold.map(({ profile, series, p95 }) => ({ profile, series, p95 })),
      groups,
      hygiene,
    },
    null,
    2,
  ),
);
