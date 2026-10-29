import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { FileBoundary, createDatabase } from '@memoria/db';
import type { PageAccessRequest, FilePlan } from '@memoria/db';
import { UploadService } from '@memoria/storage/uploads';
import { S3ObjectStorage } from '@memoria/storage';
import { storageFixture } from './testing/storage-fixture.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';

const deferred = () => {
  let resolve!: () => void;
  const promise = new Promise<void>((r) => {
    resolve = r;
  });
  return { promise, resolve };
};
await test(
  '7a actual RustFS collector races, retries and transactional attachments',
  { timeout: 120000 },
  async (t) => {
    process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
    const storage = await storageFixture(),
      db = await testDatabase();
    const gcUrl = new URL(db.url);
    gcUrl.searchParams.set('application_name', 'memoria_file_gc_race');
    const gcPool = createDatabase(gcUrl.toString()).pool;
    const jobs = new UploadService(gcPool, storage.config),
      boundary = new FileBoundary(db.pool);
    const a: PageAccessRequest = { ...db, key: db.user };
    const bytes = Buffer.alloc(1024, 31),
      checksum = createHash('sha256').update(bytes).digest('base64');
    const row = async (id: string) =>
      (
        await db.pool.query(
          'SELECT f.*,i.* FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.id=$1',
          [id],
        )
      ).rows[0];
    const quota = async () =>
      Number(
        (
          await db.pool.query(
            'SELECT reserved_bytes FROM file_workspace_usage WHERE workspace_id=$1',
            [db.workspace],
          )
        ).rows[0].reserved_bytes,
      );
    async function uploaded() {
      const started = await jobs.initiate(a, {
          bytes: bytes.length,
          name: 'race-fixture',
          idempotency: randomUUID(),
          checksum,
        }),
        id = started.id;
      const signed = await jobs.sign(a, id, randomUUID(), [
        { number: 1, bytes: bytes.length, checksum },
      ]);
      const cap = signed.signatures[0]!;
      assert('post' in cap);
      const form = new FormData();
      for (const [k, v] of Object.entries(cap.post.fields)) form.append(k, v);
      form.append('file', new Blob([bytes]));
      assert((await fetch(cap.post.url, { method: 'POST', body: form })).ok);
      await jobs.complete(a, id);
      await jobs.tick();
      assert.equal((await row(id)).state, 'validating');
      // Type decoding is 7b. Only this fixture promotes the byte-verified object to ready.
      await db.pool.query(
        "UPDATE files SET state='ready',ever_attached=true,orphaned_at=now()-interval '31 days' WHERE id=$1",
        [id],
      );
      await db.pool.query(
        "UPDATE file_upload_intents SET attach_until=now()+interval '1 day',closed_at=now(),next_attempt_at=now()+interval '1 day' WHERE file_id=$1",
        [id],
      );
      // Advance the capability clock only in SQL; real URL expiry is tested by conformance.
      await db.pool.query(
        "UPDATE file_part_leases SET expires_at=now()-interval '121 seconds' WHERE file_id=$1",
        [id],
      );
      return { id, final: (await row(id)).final_key as string };
    }
    async function plan(id: string) {
      const ref = { slot: randomUUID(), file: id };
      const existing = (
        await db.pool.query(
          "SELECT file_id FROM file_usages WHERE page_id=$1 AND slot_kind='block'",
          [db.page],
        )
      ).rows.map((r) => r.file_id as string);
      return { ref, plan: await boundary.plan([{ ...ref, author: a }], db.page, existing) };
    }
    async function attach(plan: FilePlan, ref: { slot: string; file: string }) {
      return boundary.transaction(async (c) => {
        await boundary.lock(c, db.workspace, plan);
        await boundary.replaceBlocks(c, db.workspace, db.page, db.generation, 1, [ref], plan);
      });
    }
    async function waitForGc(pid: number) {
      for (let i = 0; i < 100; i++) {
        const r = await db.pool.query(
          "SELECT 1 FROM pg_stat_activity WHERE application_name='memoria_file_gc_race' AND $1=ANY(pg_blocking_pids(pid))",
          [pid],
        );
        if (r.rowCount) return;
        await new Promise((r) => setTimeout(r, 10));
      }
      throw new Error('Collector did not wait for the attachment transaction');
    }
    try {
      await t.test(
        'attachment commits first: waiting GC rechecks retained usage and keeps object/quota',
        async () => {
          const file = await uploaded(),
            p = await plan(file.id),
            c = await db.pool.connect();
          let pending: Promise<boolean> | undefined;
          try {
            await c.query('BEGIN');
            await boundary.lock(c, db.workspace, p.plan);
            await boundary.replaceBlocks(
              c,
              db.workspace,
              db.page,
              db.generation,
              1,
              [p.ref],
              p.plan,
            );
            const before = await quota(),
              pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            pending = jobs.tick();
            await waitForGc(pid);
            await c.query('COMMIT');
            await pending;
            assert.equal((await row(file.id)).state, 'ready');
            assert(await storage.storage.head(file.final));
            assert.equal(await quota(), before);
          } finally {
            await c.query('ROLLBACK');
            await pending;
            c.release();
          }
        },
      );
      await t.test(
        'attachment rolls back: waiting GC collects; a stale plan cannot resurrect it',
        async () => {
          const file = await uploaded(),
            p = await plan(file.id),
            c = await db.pool.connect();
          let pending: Promise<boolean> | undefined;
          try {
            await c.query('BEGIN');
            await boundary.lock(c, db.workspace, p.plan);
            await boundary.replaceBlocks(
              c,
              db.workspace,
              db.page,
              db.generation,
              2,
              [p.ref],
              p.plan,
            );
            const before = await quota(),
              pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            pending = jobs.tick();
            await waitForGc(pid);
            await c.query('ROLLBACK');
            await pending;
            assert.equal((await row(file.id)).state, 'deleted');
            assert.equal(await storage.storage.head(file.final), null);
            assert((await quota()) < before);
            await assert.rejects(attach(p.plan, p.ref), /FILE_UNAVAILABLE/);
            assert.equal(
              (await db.pool.query('SELECT 1 FROM file_usages WHERE file_id=$1', [file.id]))
                .rowCount,
              0,
            );
          } finally {
            await c.query('ROLLBACK');
            await pending;
            c.release();
          }
        },
      );
      await t.test(
        'GC marks deleting first: attachment fails during the actual S3 delete',
        async () => {
          const file = await uploaded(),
            p = await plan(file.id),
            entered = deferred(),
            release = deferred();
          const original = S3ObjectStorage.prototype.delete;
          S3ObjectStorage.prototype.delete = async function (key) {
            if (key === file.final) {
              entered.resolve();
              await release.promise;
            }
            return original.call(this, key);
          };
          const pending = jobs.tick();
          try {
            await entered.promise;
            assert.equal((await row(file.id)).state, 'deleting');
            await assert.rejects(attach(p.plan, p.ref), /FILE_UNAVAILABLE/);
          } finally {
            release.resolve();
            await pending;
            S3ObjectStorage.prototype.delete = original;
          }
          assert.equal((await row(file.id)).state, 'deleted');
          assert.equal(await storage.storage.head(file.final), null);
        },
      );
      await t.test(
        'delete failure keeps quota; restart retries and releases it exactly once',
        async () => {
          const file = await uploaded(),
            before = await quota(),
            original = S3ObjectStorage.prototype.delete;
          S3ObjectStorage.prototype.delete = async function (key) {
            if (key === file.final) throw new Error('simulated S3 deletion outage');
            return original.call(this, key);
          };
          try {
            await jobs.tick();
          } finally {
            S3ObjectStorage.prototype.delete = original;
          }
          assert.equal((await row(file.id)).state, 'deleting');
          assert.equal(await quota(), before);
          assert(await storage.storage.head(file.final));
          await db.pool.query(
            'UPDATE file_upload_intents SET next_attempt_at=now() WHERE file_id=$1',
            [file.id],
          );
          const restarted = new UploadService(gcPool, storage.config);
          try {
            await restarted.tick();
            const after = await quota();
            assert(after < before);
            await restarted.tick();
            assert.equal(await quota(), after);
          } finally {
            restarted.close();
          }
          assert.equal((await row(file.id)).state, 'deleted');
        },
      );
      await t.test(
        'rights mutation commits while attachment waits: live recheck rejects the stale plan',
        async () => {
          const file = await uploaded(),
            p = await plan(file.id),
            rights = await db.pool.connect();
          let pending: Promise<unknown> | undefined;
          try {
            await rights.query('BEGIN');
            await rights.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
              db.workspace,
            ]);
            await rights.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [db.page]);
            pending = attach(p.plan, p.ref).then(
              () => null,
              (error) => error,
            );
            const pid = (await rights.query('SELECT pg_backend_pid() pid')).rows[0].pid;
            let waiting = false;
            for (let i = 0; i < 100 && !waiting; i++) {
              waiting = !!(
                await db.pool.query(
                  'SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))',
                  [pid],
                )
              ).rowCount;
              if (!waiting) await new Promise((r) => setTimeout(r, 10));
            }
            assert(waiting);
            await rights.query('COMMIT');
            assert.match(String(await pending), /FILE_UNAVAILABLE/);
            assert.equal(
              (await db.pool.query('SELECT 1 FROM file_usages WHERE file_id=$1', [file.id]))
                .rowCount,
              0,
            );
          } finally {
            await rights.query('ROLLBACK');
            await pending;
            rights.release();
          }
        },
      );
    } finally {
      jobs.close();
      await gcPool.end();
      await db.close();
      await storage.close();
    }
  },
);
