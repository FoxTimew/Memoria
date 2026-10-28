import pg from 'pg';
import type { Pool } from 'pg';
import { writeFile } from 'node:fs/promises';

function label(sql: string) {
  if (/pg_stat_activity/.test(sql)) return 'observer';
  if (/^UPDATE collaboration_leadership/i.test(sql)) return 'leadership-heartbeat';
  if (/FOR SHARE OF l/i.test(sql)) return 'leadership-fence';
  if (/content_lock_document/.test(sql)) return 'document-barrier';
  if (/database_lock_workspace|content_lock_workspace/.test(sql)) return 'workspace-barrier';
  if (/content_access_effects/.test(sql)) return 'access-preview';
  if (/SELECT key,level FROM content_resolve_access/.test(sql)) return 'page-rights';
  if (/^commit\b/i.test(sql)) return 'commit-reconciliation';
  if (/^update\s+"?pages"?/i.test(sql)) return 'page-update';
  if (/^SELECT 1$/i.test(sql)) return 'control-pulse';
  return 'other';
}

/** Instrumentation only, no changed timeouts or retries. Never record SQL or parameters. */
export function databaseControlDiagnostic(pool: Pool) {
  const original = pg.Client.prototype.query;
  const started = performance.now();
  const events: object[] = [];
  const clients = new Set<number>();
  const wrapper = new Proxy(original, {
    apply(fn, scope, args) {
      const config = args[0] as string | { text?: string };
      const kind = label(typeof config === 'string' ? config : (config.text ?? ''));
      if (kind === 'observer') return Reflect.apply(fn, scope, args);
      const pid = (scope as { processID?: number }).processID;
      if (pid) clients.add(pid);
      const start = performance.now();
      const record = (error?: unknown) => {
        const value = error as { code?: string; message?: string } | undefined;
        events.push({
          kind,
          pid,
          start: start - started,
          ms: performance.now() - start,
          error: !error
            ? null
            : value?.message === 'Query read timeout'
              ? 'QUERY_READ_TIMEOUT'
              : /^[0-9A-Z]{5}$/.test(value?.code ?? '')
                ? value!.code
                : 'QUERY_FAILED',
        });
      };
      const callback = args.at(-1) as unknown;
      if (typeof callback === 'function') {
        args[args.length - 1] = (...result: unknown[]) => {
          record(result[0]);
          return Reflect.apply(callback, undefined, result);
        };
        return Reflect.apply(fn, scope, args);
      }
      const result = Reflect.apply(fn, scope, args) as Promise<unknown>;
      return result.then(
        (value) => {
          record();
          return value;
        },
        (error: unknown) => {
          record(error);
          throw error;
        },
      );
    },
  });
  pg.Client.prototype.query = wrapper;
  let sampling: Promise<void> | undefined;
  const timer = setInterval(() => {
    if (sampling) return;
    sampling = (async () => {
      const result = await pool.query<{
        pid: number;
        query: string;
        wait_event_type: string | null;
        wait_event: string | null;
        blockers: number[];
        age_ms: number;
      }>(
        `SELECT pid,query,wait_event_type,wait_event,pg_blocking_pids(pid) AS blockers,
          extract(epoch FROM clock_timestamp()-query_start)*1000 AS age_ms
         FROM pg_stat_activity WHERE pid=ANY($1::int[]) AND state='active'`,
        [[...clients]],
      );
      events.push({
        sampleAt: performance.now() - started,
        active: result.rows.map(({ query, ...row }) => ({ ...row, kind: label(query) })),
      });
    })()
      .catch(() => {
        events.push({ observerError: true });
      })
      .finally(() => {
        sampling = undefined;
      });
  }, 100);
  return async () => {
    clearInterval(timer);
    await sampling;
    pg.Client.prototype.query = original;
    await writeFile(
      '.local/session-6d-tree-control-diagnostic.json',
      JSON.stringify(
        {
          protocol:
            'Diagnostic only; PG query timings and blocking PIDs, no SQL or values; not a qualification series.',
          events,
        },
        null,
        2,
      ) + '\n',
    );
  };
}
