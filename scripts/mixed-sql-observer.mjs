// Separate process: observing SQL must not be delayed by the measured Node event loop.
import { createRequire } from 'node:module';
import { setTimeout as delay } from 'node:timers/promises';
import { writeFile } from 'node:fs/promises';
import { resolve, relative } from 'node:path';
const pg = createRequire(new URL('../apps/collab/package.json', import.meta.url))('pg');
let client,
  active = false,
  stopping = false,
  pids = [];
const samples = [];
process.on('disconnect', () => {
  stopping = true;
});
process.on('message', async (m) => {
  if (m.kind === 'pids') pids = m.pids;
  if (m.kind === 'start') active = true;
  if (m.kind === 'stop') {
    stopping = true;
    active = false;
  }
  if (m.kind !== 'configure') return;
  try {
    client = new pg.Client({
      connectionString: m.url,
      application_name: 'memoria-mixed-observer',
      query_timeout: 1500,
    });
    await client.connect();
    process.send?.({ kind: 'ready' });
    while (!stopping) {
      if (active && pids.length) {
        const at = Date.now(),
          start = performance.now();
        const result = await client.query(
          `SELECT pid,wait_event_type,wait_event,state,
          extract(epoch FROM(clock_timestamp()-query_start))*1000 AS age_ms,
          pg_blocking_pids(pid) AS blockers FROM pg_stat_activity WHERE pid=ANY($1::int[])`,
          [pids],
        );
        samples.push({ at, elapsedMs: performance.now() - start, rows: result.rows });
      }
      await delay(20);
    }
  } catch (error) {
    process.exitCode = 1;
    samples.push({ error: { code: error.code, message: error.message } });
  } finally {
    const path = resolve(m.output);
    const rel = relative(resolve('.local/mixed-profile'), path);
    if (!rel.startsWith('..') && !rel.includes(':'))
      await writeFile(path, JSON.stringify({ samples }) + '\n');
    await client?.end();
    process.disconnect?.();
  }
});
