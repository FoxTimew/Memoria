import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import type { TestDatabase } from '../../../collab/src/testing/database.ts';
import { securityPeer } from '../../../collab/src/testing/security-peer.ts';
import { applyCommands } from '../../../collab/src/service/commands.ts';
import { firstText, until } from '../../../collab/src/testing/pool-helpers.ts';
import { pageSchema, collaborationAccessSchema, pageSharesSchema } from '@memoria/contracts';

type Call = (
  path: string,
  body?: unknown,
  method?: string,
) => Promise<{ status: number; data: unknown }>;
const distribution = (values: number[]) => {
  assert(values.length > 0);
  const sorted = [...values].sort((a, b) => a - b);
  return {
    n: values.length,
    p50: sorted[Math.ceil(sorted.length * 0.5) - 1],
    p95: sorted[Math.ceil(sorted.length * 0.95) - 1],
    max: sorted.at(-1),
    samples: values,
  };
};
/** Real HTTP mutations and four real WSS writers; SQL is only fixture setup/inspection. */
export async function measureRights(
  pool: TestDatabase['pool'],
  call: Call,
  cookie: string,
  url: string,
  origin: string,
) {
  const reports: object[] = [];
  const ok = async (p: ReturnType<Call>, status = 200) => {
    const r = await p;
    assert.equal(r.status, status);
    return r.data;
  };
  for (let series = 1; series <= 3; series++) {
    const power = JSON.parse(
      execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
        encoding: 'utf8',
        windowsHide: true,
      }),
    );
    const freeBytes = freemem();
    console.log(JSON.stringify({ series, power, freeBytes }));
    assert(power.allowed, 'AC power required');
    assert(
      freeBytes >= 3 * 1024 ** 3,
      'FREE_RAM_BELOW_3_GIB: free memory before running this series',
    );
    const workspace = (
      (await ok(
        call('/api/internal/workspaces', { name: '5d load', slug: 'load-' + randomUUID() }),
        201,
      )) as { id: string }
    ).id;
    const base = `/api/internal/workspaces/${workspace}`;
    const roots: ReturnType<typeof pageSchema.parse>[] = [];
    for (let i = 0; i < 4; i++)
      roots.push(
        pageSchema.parse(
          await ok(call(base + '/pages', { title: `Writer ${i}`, parentId: null }), 201),
        ),
      );
    // 50 memberships, 1000 pages, 4 branches of 250 pages, existing workspaces untouched.
    const client = await pool.connect();
    const targets = [randomUUID(), randomUUID()];
    try {
      await client.query('BEGIN');
      for (let i = 0; i < 49; i++) {
        const user = randomUUID(),
          member = i < 2 ? targets[i] : randomUUID();
        await client.query(
          "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Load fixture',$2,true)",
          [user, user + '@example.test'],
        );
        await client.query(
          'INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)',
          [member, workspace, user, i === 0 ? 'guest' : 'member'],
        );
        await client.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
          workspace,
          user,
        ]);
      }
      await client.query(
        "INSERT INTO pages(id,workspace_id,parent_id,position,title) SELECT gen_random_uuid(),$1,($2::uuid[])[(n-1)%4+1],'a'||lpad(n::text,5,'0'),'Load child' FROM generate_series(1,996) n",
        [workspace, roots.map((p) => p.id)],
      );
      await client.query('COMMIT');
    } catch (e) {
      await client.query('ROLLBACK');
      throw e;
    } finally {
      client.release();
    }
    assert.equal(
      (await pool.query('SELECT count(*) n FROM pages WHERE workspace_id=$1', [workspace])).rows[0]
        .n,
      '1000',
    );
    assert.equal(
      (
        await pool.query('SELECT count(*) n FROM workspace_members WHERE workspace_id=$1', [
          workspace,
        ])
      ).rows[0].n,
      '50',
    );
    const peers: ReturnType<typeof securityPeer>[] = [];
    let running = true;
    const writes: { start: number; end: number; ms: number }[] = [];
    const mutations: { kind: string; start: number; end: number; ms: number }[] = [];
    const loops: Promise<void>[] = [];
    try {
      for (const root of roots) {
        const meta = collaborationAccessSchema.parse(
          await ok(call(`${base}/pages/${root.id}/collaboration`, {}), 201),
        );
        const peer = securityPeer(
          url,
          `${workspace}:${root.id}:${meta.generation}`,
          cookie,
          origin,
          JSON.stringify({ scope: 'page', ...meta.identity, accessVersion: meta.accessVersion }),
        );
        peers.push(peer);
        await until(() => peer.provider.isSynced, 'writer synchronized');
        let receipt = 0;
        peer.provider.on('stateless', ({ payload }: { payload: string }) => {
          const r = JSON.parse(payload);
          if (r.status === 'durable' && r.kind !== 'sync') receipt++;
        });
        const before = receipt;
        peer.doc.transact(() =>
          applyCommands(peer.doc, [
            {
              op: 'insert',
              id: randomUUID(),
              parentId: null,
              afterId: null,
              type: 'core.paragraph',
              schemaVersion: 1,
              content: { spans: [{ type: 'text', text: 'Load', styles: {} }] },
            },
          ]),
        );
        await until(() => receipt > before, 'initial paragraph durable');
        loops.push(
          (async () => {
            while (running) {
              assert(!peer.closed && !peer.failed, 'Unrelated writer was disconnected');
              const count = receipt,
                start = performance.now();
              firstText(peer.doc).insert(0, 'x');
              // Short polling bounds observation error to about 1ms, no SQL read in timed scope.
              while (receipt === count) {
                assert(performance.now() - start < 10000, 'Missing durable confirmation');
                await delay(1);
              }
              const end = performance.now();
              writes.push({ start, end, ms: end - start });
              await delay(Math.max(0, 200 - (end - start)));
            }
          })(),
        );
      }
      await delay(1500);
      const measure = async (kind: string, task: () => Promise<unknown>) => {
        const start = performance.now();
        await task();
        const end = performance.now();
        mutations.push({ kind, start, end, ms: end - start });
      };
      // 24 mutations/series stay inside the real 30/min/account budget.
      for (let cycle = 0; cycle < 6; cycle++) {
        const state = pageSharesSchema.parse(
          await ok(call(`${base}/pages/${roots[0]!.id}/shares`)),
        );
        await measure('share', () =>
          ok(
            call(
              `${base}/pages/${roots[0]!.id}/shares/${targets[0]}`,
              { expectedAccessVersion: state.accessVersion, level: 'edit' },
              'PUT',
            ),
          ),
        );
        await measure('role-promote', () =>
          ok(
            call(
              `${base}/members/${targets[0]}/role`,
              { expectedRole: 'guest', role: 'member' },
              'PUT',
            ),
          ),
        );
        await measure('role-demote', () =>
          ok(
            call(
              `${base}/members/${targets[0]}/role`,
              {
                expectedRole: 'member',
                role: 'guest',
                roots: [{ pageId: roots[0]!.id, level: 'read' }],
              },
              'PUT',
            ),
          ),
        );
        const removed = (
          await pool.query('SELECT user_id FROM workspace_members WHERE id=$1', [targets[1]])
        ).rows[0].user_id;
        await measure('remove', () =>
          ok(call(`${base}/members/${targets[1]}`, { expectedRole: 'member' }, 'DELETE')),
        );
        // Restore the fixture between samples, outside the measured mutation.
        await pool.query(
          "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
          [targets[1], workspace, removed],
        );
        await delay(210);
      }
      await delay(1500);
    } finally {
      running = false;
      await Promise.all(loops);
      for (const p of peers) p.destroy();
    }
    const overlaps = (w: { start: number; end: number }) =>
      mutations.some((m) => w.start <= m.end && w.end >= m.start);
    const overlap = writes.filter(overlaps);
    assert(overlap.length >= 10, 'At least ten real writes must overlap HTTP mutations');
    const report = {
      series,
      power,
      freeBytes,
      pages: 1000,
      members: 50,
      writers: 4,
      updatesPerSecondPerWriter: 5,
      mutations: Object.fromEntries(
        [...new Set(mutations.map((m) => m.kind))].map((kind) => [
          kind,
          distribution(mutations.filter((m) => m.kind === kind).map((m) => m.ms)),
        ]),
      ),
      editorConfirmations: distribution(writes.map((w) => w.ms)),
      overlappingConfirmations: distribution(overlap.map((w) => w.ms)),
      outsideMutationConfirmations: distribution(
        writes.filter((w) => !overlaps(w)).map((w) => w.ms),
      ),
      timeline: { mutations, writes },
    };
    reports.push(report);
    console.log(JSON.stringify({ ...report, timeline: undefined }));
    await writeFile(
      '.local/session-5d-rights-load.json',
      JSON.stringify(
        {
          scope:
            'HTTP end-to-end mutations, 1000 pages/50 memberships, four WSS editors at 5 updates/s each. Confirmation includes network/queue/validation/commit. No invented causal SQL-wait attribution.',
          reports,
        },
        null,
        2,
      ) + '\n',
    );
    // Quotas remain active during each series; fixture reset only BETWEEN series.
    await pool.query('TRUNCATE auth_buckets');
  }
}
