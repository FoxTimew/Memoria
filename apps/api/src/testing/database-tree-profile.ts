import assert from 'node:assert/strict';
import { writeFile } from 'node:fs/promises';
import type { PoolClient } from '@memoria/db';
import { runMeasuredSeries } from '../../../../scripts/measurement-memory.mjs';
import type { Preparation } from '../../../../scripts/measurement-memory.mjs';
import { DatabaseService } from '../database.module.ts';
import type { databaseHttpHarness, Reader } from './database-http-fixture.ts';

/** Diagnostic SQL plans on the native mutation, no app timeout or authorization changes. */
export async function profileDatabaseTree(
  h: Awaited<ReturnType<typeof databaseHttpHarness>>,
  owner: Reader,
  preparation: Preparation,
  tree: { root: string; parent: string | null; destination: string },
) {
  const captured = new Map<string, { text: string; values: unknown[] }>();
  let recording = false;
  const wrapped = new WeakSet<PoolClient>();
  const instrument = (client: PoolClient) => {
    if (wrapped.has(client)) return;
    wrapped.add(client);
    client.query = new Proxy(client.query, {
      apply(fn, scope, args) {
        const config = args[0] as string | { text: string; values?: unknown[] };
        const text = typeof config === 'string' ? config : config.text;
        if (recording && /content_resolve_access|content_access_effects/.test(text)) {
          const values = typeof config === 'string' ? args[1] : (config.values ?? args[1]);
          captured.set(text.includes('content_resolve_access') ? 'rights' : 'preview', {
            text,
            values: Array.isArray(values) ? values : [],
          });
        }
        return Reflect.apply(fn, scope, args);
      },
    });
  };
  const pool = h.app.get(DatabaseService).pool;
  pool.on('acquire', instrument);
  const reset = () =>
    h.f.db.pool.query('UPDATE pages SET parent_id=$1 WHERE id=$2', [tree.parent, tree.root]);
  const reports: unknown[] = [];
  try {
    for (let series = 1; series <= 3; series++) {
      await reset();
      await h.prove(owner);
      const { result, hygiene } = await runMeasuredSeries(
        `database-http-tree-profile-${series}`,
        async () => {
          const page = (
            await h.f.db.pool.query('SELECT version FROM pages WHERE id=$1', [tree.root])
          ).rows[0];
          const path = `/api/internal/workspaces/${owner.workspace}/pages/${tree.root}/move`;
          const body = {
            expectedVersion: Number(page.version),
            parentId: tree.destination,
            afterId: null,
          };
          const preview = await h.call(owner, body, path + '/preview');
          assert.equal(preview.status, 201);
          recording = true;
          const mutation = await h.call(owner, { ...body, previewToken: preview.data.token }, path);
          recording = false;
          assert.equal(mutation.status, 201);
          assert(captured.has('preview'));
          const plans: object[] = [];
          const definition = (
            await h.f.db.pool.query(
              "SELECT pg_get_functiondef('content_resolve_access(jsonb)'::regprocedure) AS source",
            )
          ).rows[0].source as string;
          const inner = definition.match(/RETURN QUERY\s+([\s\S]*);\s*END/i)?.[1];
          assert(
            inner && inner.startsWith('WITH RECURSIVE'),
            'Inspect actual installed resolver body',
          );
          const queries = [...captured.entries()];
          if (captured.has('rights'))
            queries.push([
              'rights-inner',
              {
                text: inner.replace(/\brequests\b/g, '$1::jsonb'),
                values: captured.get('rights')!.values,
              },
            ]);
          for (const [name, query] of queries) {
            await reset();
            const client = await h.f.db.pool.connect();
            try {
              await client.query('BEGIN');
              await client.query("SET LOCAL track_functions='all'");
              await client.query('SELECT database_lock_workspace($1)', [owner.workspace]);
              const plan = await client.query(
                'EXPLAIN (ANALYZE,BUFFERS,FORMAT JSON) ' + query.text,
                query.values,
              );
              const functions = (
                await client.query(
                  'SELECT funcname,calls,total_time,self_time FROM pg_stat_xact_user_functions WHERE schemaname=current_schema() ORDER BY funcname',
                )
              ).rows;
              plans.push({ name, plan: plan.rows[0]['QUERY PLAN'][0], functions });
            } finally {
              await client.query('ROLLBACK');
              client.release();
            }
          }
          return { previewMs: preview.server, mutationMs: mutation.server, plans };
        },
        { preparation },
      );
      reports.push({ series, hygiene, ...result });
      await writeFile(
        '.local/session-6d-tree-profile.json',
        JSON.stringify(
          {
            protocol:
              'Three diagnostic series, one native HTTP move per series, no WSS writers. Captured native rights/preview query plans after restoring the tree; inner resolver plan from the installed PL/pgSQL RETURN QUERY body, same values. EXPLAIN ANALYZE under the real workspace barrier, rolled back, track_functions=all. No query parameter list or credentials recorded. Not a qualification p95.',
            preparation,
            reports,
          },
          null,
          2,
        ) + '\n',
      );
      console.log(
        JSON.stringify({
          treeProfile: series,
          previewMs: result.previewMs,
          mutationMs: result.mutationMs,
        }),
      );
    }
  } finally {
    recording = false;
    pool.off('acquire', instrument);
  }
}
