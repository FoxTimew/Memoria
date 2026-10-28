import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { test } from 'node:test';
import type { PoolClient } from 'pg';
import { testDatabase } from './database.ts';

type Op = { kind: string; member: number; page: number; parent: number; choice: number };
type Step = { rollback: boolean; ops: Op[] };
const kinds = [
  'role',
  'grant',
  'unshare',
  'subject',
  'move',
  'archive',
  'restore',
  'remove',
  'join',
];
const id = (s: string) => {
  const h = createHash('sha256')
    .update('memoria-random-rights:' + s)
    .digest('hex');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-4${h.slice(13, 16)}-a${h.slice(17, 20)}-${h.slice(20, 32)}`;
};
const seed = Number(process.env.MEMORIA_RECONCILIATION_SEED ?? 0x6a202610) >>> 0;
function generate(count: number): Step[] {
  let state = seed;
  const next = (n: number) => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    return Math.floor((state / 2 ** 32) * n);
  };
  return Array.from({ length: count }, () => ({
    rollback: next(5) === 0,
    ops: Array.from({ length: 1 + next(3) }, () => {
      const page = 1 + next(39);
      return {
        kind: kinds[next(kinds.length)]!,
        member: next(12),
        page,
        parent: next(page),
        choice: next(4),
      };
    }),
  }));
}

/** Delta debugging, followed by single deletions: 1-minimal, not a claim of global shortest length. */
async function minimize<T>(input: T[], fails: (items: T[]) => Promise<boolean>): Promise<T[]> {
  let result = [...input],
    chunks = 2;
  while (result.length) {
    const size = Math.ceil(result.length / chunks);
    let reduced = false;
    for (let i = 0; i < result.length; i += size) {
      const candidate = result.filter((_, index) => index < i || index >= i + size);
      if (await fails(candidate)) {
        result = candidate;
        chunks = Math.max(2, chunks - 1);
        reduced = true;
        break;
      }
    }
    if (!reduced) {
      if (chunks >= result.length) break;
      chunks = Math.min(result.length, chunks * 2);
    }
  }
  return result;
}

class EquivalenceError extends Error {}
async function replay(steps: Step[]) {
  const db = await testDatabase();
  const c = await db.pool.connect();
  const generations = Array.from({ length: 12 }, () => 0);
  const w = db.workspace,
    p = (n: number) => (n === 0 ? db.page : id('page' + n)),
    m = (n: number) => id('member' + n + ':' + generations[n]),
    s = (n: number) => id('subject' + n + ':' + generations[n]);
  const effective: Record<string, number> = {};
  const join = async (n: number) =>
    c.query(
      "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'guest') ON CONFLICT DO NOTHING",
      [m(n), w, id('user' + n)],
    );
  const subject = async (n: number) =>
    c.query(
      "INSERT INTO access_subjects(id,workspace_id,kind,member_id) SELECT $1,$2,'member',id FROM workspace_members WHERE id=$3 ON CONFLICT(workspace_id,member_id) DO NOTHING",
      [s(n), w, m(n)],
    );
  const snapshot = (client: PoolClient) =>
    client.query<{ member_id: string; page_id: string; level: string; version: number }>(
      'SELECT member_id,page_id,level,version FROM page_access_state WHERE workspace_id=$1 ORDER BY member_id,page_id',
      [w],
    );
  const apply = async (op: Op) => {
    let r;
    switch (op.kind) {
      case 'role':
        r = await c.query('UPDATE workspace_members SET role=$1 WHERE id=$2', [
          ['guest', 'member', 'admin', 'guest'][op.choice],
          m(op.member),
        ]);
        break;
      case 'join':
        r = await join(op.member);
        break;
      case 'remove':
        r = await c.query('DELETE FROM workspace_members WHERE id=$1', [m(op.member)]);
        if (r.rowCount) generations[op.member]!++;
        break;
      case 'subject':
        if (op.choice === 0)
          r = await c.query('DELETE FROM access_subjects WHERE id=$1', [s(op.member)]);
        else if (op.choice === 1)
          r = await c.query('UPDATE access_subjects SET deleted_at=now() WHERE id=$1', [
            s(op.member),
          ]);
        else {
          await subject(op.member);
          r = await c.query('UPDATE access_subjects SET deleted_at=NULL WHERE id=$1', [
            s(op.member),
          ]);
        }
        break;
      case 'grant':
        await subject(op.member);
        r = await c.query(
          `INSERT INTO access_grants(workspace_id,subject_id,resource_type,resource_id,level,inherit)
          SELECT $1,id,'page',$2,$3,$4 FROM access_subjects WHERE id=$5
          ON CONFLICT(workspace_id,subject_id,resource_type,resource_id) WHERE deleted_at IS NULL DO UPDATE SET level=excluded.level,inherit=excluded.inherit`,
          [w, p(op.page), op.choice % 2 ? 'edit' : 'read', op.choice < 2, s(op.member)],
        );
        break;
      case 'unshare':
        r = await c.query('DELETE FROM access_grants WHERE subject_id=$1 AND resource_id=$2', [
          s(op.member),
          p(op.page),
        ]);
        break;
      case 'move':
        r = await c.query('UPDATE pages SET parent_id=$1 WHERE id=$2', [
          op.choice === 0 ? null : p(op.parent),
          p(op.page),
        ]);
        break;
      case 'archive':
        r = await c.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [p(op.page)]);
        break;
      case 'restore':
        r = await c.query('UPDATE pages SET deleted_at=NULL WHERE id=$1', [p(op.page)]);
        break;
      default:
        throw new Error('Unknown replay operation');
    }
    effective[op.kind] = (effective[op.kind] ?? 0) + (r.rowCount ?? 0);
  };
  const comparePreview = async (op: Op) => {
    if (!['move', 'archive', 'restore'].includes(op.kind)) return;
    const tree = (
      await c.query<{ id: string; parent_id: string | null; archived: boolean }>(
        "SELECT id,parent_id,deleted_at IS NOT NULL AS archived FROM pages WHERE workspace_id=$1 AND kind='page'",
        [w],
      )
    ).rows;
    const affected = new Set([p(op.page)]);
    for (let size = -1; size !== affected.size;) {
      size = affected.size;
      for (const page of tree)
        if (page.parent_id && affected.has(page.parent_id)) affected.add(page.id);
    }
    const target = tree.find((page) => page.id === p(op.page))!;
    if (op.kind === 'move') target.parent_id = op.choice === 0 ? null : p(op.parent);
    else target.archived = op.kind === 'archive';
    const guests = (
      await c.query<{ id: string }>(
        "SELECT id FROM workspace_members WHERE workspace_id=$1 AND role='guest'",
        [w],
      )
    ).rows.map((m) => m.id);
    const candidate = JSON.stringify(tree);
    const full = (
      await c.query(
        'SELECT * FROM content_access_effects($1,$2::jsonb,false) ORDER BY member_id,page_id',
        [w, candidate],
      )
    ).rows;
    const bounded = (
      await c.query(
        'SELECT * FROM content_access_effects_bounded($1,$2::jsonb,false,$3::uuid[],$4::uuid[]) ORDER BY member_id,page_id',
        [w, candidate, guests, [...affected]],
      )
    ).rows;
    try {
      assert.deepEqual(
        bounded,
        full.filter((row) => guests.includes(row.member_id) && affected.has(row.page_id)),
        'targeted preview equals full oracle after arbitrary preceding mutations',
      );
    } catch (error) {
      throw new EquivalenceError(`preview=${op.kind}: ${String(error)}`);
    }
    effective.preview = (effective.preview ?? 0) + 1;
  };
  try {
    await c.query('BEGIN');
    for (let n = 1; n < 40; n++)
      await c.query('INSERT INTO pages(id,workspace_id,parent_id,position) VALUES($1,$2,$3,$4)', [
        p(n),
        w,
        p(Math.floor((n - 1) / 3)),
        'a' + n.toString().padStart(4, '0'),
      ]);
    for (let n = 0; n < 12; n++) {
      await c.query(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Random fixture',$2,true)",
        [id('user' + n), `random${n}@example.test`],
      );
      await join(n);
      await subject(n);
      await c.query('UPDATE workspace_members SET role=$1 WHERE id=$2', [
        n % 2 ? 'member' : 'guest',
        m(n),
      ]);
      for (let j = 0; j < 4; j++)
        await c.query(
          "INSERT INTO access_grants(workspace_id,subject_id,resource_id,level,inherit) VALUES($1,$2,$3,'read',true)",
          [w, s(n), p(1 + ((n * 3 + j) % 39))],
        );
    }
    await c.query('COMMIT');
    for (let i = 0; i < steps.length; i++) {
      const before = await snapshot(c);
      const priorGenerations = [...generations];
      await c.query('BEGIN');
      for (const op of steps[i]!.ops) {
        await comparePreview(op);
        await apply(op);
      }
      await c.query(steps[i]!.rollback ? 'ROLLBACK' : 'COMMIT');
      if (steps[i]!.rollback) generations.splice(0, generations.length, ...priorGenerations);
      const actual = (await snapshot(c)).rows;
      const complete = (
        await c.query('SELECT * FROM content_effective_access($1) ORDER BY member_id,page_id', [w])
      ).rows;
      try {
        assert.deepEqual(
          actual
            .filter((r) => r.level !== 'none')
            .map(({ member_id, page_id, level }) => ({ member_id, page_id, level })),
          complete,
        );
        assert.equal(
          (await c.query('SELECT * FROM page_access_pending WHERE workspace_id=$1', [w])).rowCount,
          0,
        );
        if (steps[i]!.rollback) assert.deepEqual(actual, before.rows);
        else {
          const prior = new Map(before.rows.map((r) => [r.member_id + ':' + r.page_id, r]));
          for (const row of actual) {
            const old = prior.get(row.member_id + ':' + row.page_id);
            if (old?.level === row.level)
              assert.equal(row.version, old.version, 'unchanged effective right must retain epoch');
            else if (old)
              assert(row.version > old.version, 'changed effective right must advance epoch');
          }
        }
      } catch (error) {
        throw new EquivalenceError(`step=${i}: ${String(error)}`);
      }
    }
    return effective;
  } finally {
    await c.query('ROLLBACK');
    c.release();
    await db.close();
  }
}

test('random rights equivalence: 500 seeded transactions and durable epoch oracle', async () => {
  await mkdir('.local', { recursive: true });
  const source = process.env.MEMORIA_RECONCILIATION_REPLAY;
  let steps: Step[] = source ? JSON.parse(await readFile(source, 'utf8')).steps : generate(500);
  const path = '.local/session-6a-reconciliation-random.json';
  console.log(
    JSON.stringify({
      seed,
      steps: steps.length,
      operations: steps.reduce((n, s) => n + s.ops.length, 0),
    }),
  );
  await writeFile(path, JSON.stringify({ seed, steps, status: 'running' }, null, 2) + '\n');
  try {
    const effective = await replay(steps);
    await writeFile(
      path,
      JSON.stringify({ seed, steps, effective, status: 'passed' }, null, 2) + '\n',
    );
    console.log(JSON.stringify({ seed, status: 'passed', effective }));
  } catch (error) {
    await writeFile(
      path,
      JSON.stringify({ seed, steps, status: 'failed', error: String(error) }, null, 2) + '\n',
    );
    if (error instanceof EquivalenceError) {
      const fails = async (candidate: Step[]) => {
        try {
          await replay(candidate);
          return false;
        } catch (e) {
          if (e instanceof EquivalenceError) return true;
          throw e;
        }
      };
      steps = await minimize(steps, fails);
      for (let i = 0; i < steps.length; i++) {
        const index = i;
        const ops = await minimize(steps[i]!.ops, async (ops) =>
          fails(steps.map((s, j) => (j === index ? { ...s, ops } : s))),
        );
        steps[i] = { ...steps[i]!, ops };
      }
      // Re-minimize after trimming inner transactions; preserve rollback boundaries.
      steps = await minimize(steps, fails);
      assert(await fails(steps), 'minimized reproducer must still fail');
      const minimized = '.local/session-6a-reconciliation-minimal.json';
      await writeFile(
        minimized,
        JSON.stringify(
          {
            seed,
            steps,
            minimality: '1-minimal transaction deletion; reduced operations',
            error: String(error),
          },
          null,
          2,
        ) + '\n',
      );
      console.error(JSON.stringify({ seed, minimized, steps }));
    }
    throw error;
  }
});

test('delta reducer retains a verified minimal causal sequence', async () => {
  const result = await minimize(
    [1, 2, 3, 4, 5, 6, 7],
    async (sequence) =>
      sequence.includes(2) && sequence.includes(6) && sequence.indexOf(2) < sequence.indexOf(6),
  );
  assert.deepEqual(result, [2, 6]);
});
