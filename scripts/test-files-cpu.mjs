import { spawn, fork } from 'node:child_process';
import { once } from 'node:events';
import { writeFile, mkdir } from 'node:fs/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { resolve } from 'node:path';
import { prepareMeasurement, runMeasuredSeries } from './measurement-memory.mjs';

const seriesOption = (name, fallback) => {
  const index = process.argv.indexOf(name);
  return index < 0 ? fallback : Number(process.argv[index + 1]);
};
const first = seriesOption('--first-series', 1),
  last = seriesOption('--last-series', 3);
const extended = process.argv.includes('--extended-cpu');
if (![first, last].every((n) => Number.isInteger(n) && n >= 1 && n <= 3) || first > last)
  throw Error('CPU_SERIES_RANGE_INVALID');
const campaignPrefix = extended ? 'cpu-extended-campaign' : 'cpu-campaign';
const campaignPath =
  first === 1 && last === 3
    ? `.local/7d/${campaignPrefix}.json`
    : `.local/7d/${campaignPrefix}-${first}-${last}.json`;

const run = async (file, args, cwd) => {
  const child = spawn(process.execPath, [resolve(file), ...args], {
    stdio: 'inherit',
    windowsHide: true,
    cwd,
  });
  const [code] = await once(child, 'exit');
  if (code !== 0) throw Error('CPU_BUILD_FAILED');
};
// Complete all builds before preparation; no compiler during the diagnostic interval.
await run('scripts/build-collab.mjs', ['--cpu-front']);
await run('scripts/build-server.mjs', ['api', '--files-ui-e2e']);
if (!process.argv.includes('--built-web'))
  await run('scripts/run-web.mjs', ['build'], resolve('apps/web'));
const reports = [];
for (let series = first; series <= last; series++) {
  const label = (extended ? 'files-cpu-extended-' : 'files-cpu-front-') + series;
  const preparation = await prepareMeasurement(label);
  const child = fork(
    'apps/api/dist/files-ui.e2e.mjs',
    ['--cpu', ...(extended ? ['--extended-cpu'] : [])],
    {
      execArgv: ['--env-file=.env', '--use-system-ca'],
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      windowsHide: true,
    },
  );
  const ended = once(child, 'exit');
  let closed = false;
  void ended.then(() => {
    closed = true;
  });
  try {
    await new Promise((yes, no) => {
      child.on('message', (m) => {
        if (m.kind === 'prepared') yes();
      });
      child.once('error', no);
      child.once('exit', () => no(Error('CPU_FRONT_PREPARATION_FAILED')));
    });
    const measured = await runMeasuredSeries(
      label,
      async () => {
        child.send({ kind: 'start' });
        const [code] = await ended;
        return { code };
      },
      { preparation, maxAttempts: 1 },
    );
    reports.push({ series, ...measured });
    await mkdir('.local/7d', { recursive: true });
    await writeFile(
      campaignPath,
      JSON.stringify({ date: new Date().toISOString(), diagnostic: true, reports }, null, 2) + '\n',
    );
    if (measured.result.code !== 0) throw Error('STOP_CPU_FRONT_KEEP_DIAGNOSTIC');
  } finally {
    if (!closed) {
      child.send({ kind: 'cancel' });
      const timer = setTimeout(() => child.kill(), 40000);
      await ended;
      clearTimeout(timer);
    }
  }
}
