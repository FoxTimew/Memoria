import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { readFile, writeFile } from 'node:fs/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { prepareMeasurement, runMeasuredSeries } from '../../scripts/measurement-memory.mjs';
const suite = process.argv[2];
assert(['cold', 'capacity'].includes(suite));
const profiles = suite === 'cold' ? ['content-1M', 'history-1M'] : ['content-200K', 'history-200K'];
const reports = [];
for (let series = 1; series <= 3; series++)
  for (const profile of profiles) {
    const label = `isolation-${suite}-${profile.toLowerCase()}-${series}`;
    const preparation = await prepareMeasurement(label),
      output = resolve('.local/isolation', label + '.json');
    const child = fork(`apps/collab/dist/proof-isolation-${suite}.mjs`, [], {
      execArgv: ['--env-file=.env', ...(suite === 'capacity' ? ['--expose-gc'] : [])],
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
      env: { ...process.env, PROOF_PROFILE: profile, PROOF_OUTPUT: output },
    });
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
        child.once('exit', () => no(Error('PROOF_PREPARATION_FAILED')));
      });
      const measured = await runMeasuredSeries(
        label,
        async () => {
          child.send({ kind: 'start' });
          const [code] = await ended;
          return { code, report: JSON.parse(await readFile(output, 'utf8')) };
        },
        { preparation, maxAttempts: 1 },
      );
      reports.push({ series, profile, ...measured });
      await writeFile(
        `.local/isolation/${suite}.json`,
        JSON.stringify(
          {
            date: new Date().toISOString(),
            scope:
              'Isolated publication proof, original service controls and thresholds. Three guarded series. Not production integration.',
            reports,
          },
          null,
          2,
        ) + '\n',
      );
      assert.equal(measured.result.code, 0, 'STOP_ISOLATION_CEILING');
    } finally {
      if (!closed) {
        child.send({ kind: 'cancel' });
        const timer = setTimeout(() => child.kill(), 40000);
        await ended;
        clearTimeout(timer);
      }
    }
  }
