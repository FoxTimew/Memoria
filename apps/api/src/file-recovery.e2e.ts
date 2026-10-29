import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { fork, spawnSync } from 'node:child_process';
import { once } from 'node:events';
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { createDatabase, readFileLimits, reconcileFileCapacity, FileBoundary } from '@memoria/db';
import type { PageAccessRequest } from '@memoria/db';
import { UploadService } from '@memoria/storage/uploads';
import { S3ObjectStorage } from '@memoria/storage';
import type { StorageConfig } from '@memoria/storage';
import { storageFixture } from './testing/storage-fixture.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';

const sha = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('base64');
const deferred = () => {
  let done!: () => void;
  const promise = new Promise<void>((r) => {
    done = r;
  });
  return { promise, done };
};

// Actual worker process killed after RustFS has committed a copy, before its SQL publication.
if (process.env.MEMORIA_FILE_RECOVERY_CHILD === '1') {
  process.once('message', async (input: { url: string; config: StorageConfig }) => {
    const pool = createDatabase(input.url).pool,
      jobs = new UploadService(pool, input.config);
    const original = S3ObjectStorage.prototype.copy;
    S3ObjectStorage.prototype.copy = async function (source, target) {
      await original.call(this, source, target);
      process.send?.({ copied: true });
      await new Promise(() => {});
    };
    await jobs.tick();
    process.exitCode = 2;
  });
} else
  await test(
    '7a recovery and accounting against real PostgreSQL/RustFS',
    { timeout: 240000 },
    async (t) => {
      process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
      const store = await storageFixture();
      const bytes = Buffer.alloc(1024, 45);
      async function scenario(
        name: string,
        run: (f: Awaited<ReturnType<typeof fixture>>) => Promise<void>,
      ) {
        await t.test(name, async () => {
          const f = await fixture();
          try {
            await run(f);
          } finally {
            f.jobs.close();
            await f.db.close();
          }
        });
      }
      async function fixture() {
        const db = await testDatabase(),
          jobs = new UploadService(db.pool, store.config);
        const actor: PageAccessRequest = { ...db, key: db.user };
        const row = async (id: string) =>
          (
            await db.pool.query(
              'SELECT f.*,i.* FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.id=$1',
              [id],
            )
          ).rows[0];
        const start = async (data = bytes) =>
          jobs.initiate(actor, {
            bytes: data.length,
            name: 'recovery fixture',
            checksum: sha(data),
            idempotency: randomUUID(),
          });
        async function upload(data = bytes) {
          const { id, mode, partBytes } = await start(data);
          const chunks =
            mode === 'post'
              ? [data]
              : Array.from({ length: Math.ceil(data.length / partBytes) }, (_, i) =>
                  data.subarray(i * partBytes, (i + 1) * partBytes),
                );
          const signed = await jobs.sign(
            actor,
            id,
            randomUUID(),
            chunks.map((p, i) => ({ number: i + 1, bytes: p.length, checksum: sha(p) })),
          );
          for (const [i, s] of signed.signatures.entries()) {
            let response: Response;
            if ('post' in s) {
              const form = new FormData();
              for (const [k, v] of Object.entries(s.post.fields)) form.append(k, v);
              form.append('file', new Blob([Uint8Array.from(chunks[i]!)]));
              response = await fetch(s.post.url, { method: 'POST', body: form });
            } else
              response = await fetch(s.url, {
                method: 'PUT',
                headers: { ...s.headers, 'content-length': String(chunks[i]!.length) },
                body: Uint8Array.from(chunks[i]!),
              });
            assert(response.ok, `upload HTTP ${response.status}`);
          }
          return id;
        }
        async function retry(id: string) {
          await db.pool.query(
            'UPDATE file_upload_intents SET next_attempt_at=now() WHERE file_id=$1',
            [id],
          );
          await jobs.tick();
        }
        async function expire(id: string) {
          await db.pool.query(
            "UPDATE file_part_leases SET expires_at=now()-interval '121 seconds' WHERE file_id=$1",
            [id],
          );
          await db.pool.query(
            'UPDATE file_upload_intents SET next_attempt_at=now() WHERE file_id=$1',
            [id],
          );
        }
        return { db, jobs, actor, row, start, upload, retry, expire };
      }
      try {
        await scenario(
          'lost multipart initiation response is reconciled without a second upload or reservation',
          async (f) => {
            const original = S3ObjectStorage.prototype.initiate;
            S3ObjectStorage.prototype.initiate = async function (key) {
              await original.call(this, key);
              throw Error('lost response');
            };
            try {
              await assert.rejects(f.start(Buffer.alloc(33 * 1024 ** 2, 1)), /lost response/);
            } finally {
              S3ObjectStorage.prototype.initiate = original;
            }
            const id = (await f.db.pool.query('SELECT file_id FROM file_upload_intents')).rows[0]
              .file_id as string;
            const before = await reconcileFileCapacity(f.db.pool);
            const r = await f.row(id);
            assert.equal(r.state, 'reserved');
            assert.equal((await store.storage.uploads(r.staging_key)).length, 1);
            await f.jobs.resume(f.actor, id);
            assert.equal((await f.row(id)).state, 'uploading');
            assert.equal((await store.storage.uploads(r.staging_key)).length, 1);
            assert.deepEqual(await reconcileFileCapacity(f.db.pool), before);
          },
        );
        await scenario(
          'lost CompleteMultipartUpload response is recovered by HEAD and final bytes are verified',
          async (f) => {
            const id = await f.upload(Buffer.alloc(33 * 1024 ** 2, 2));
            await f.jobs.complete(f.actor, id);
            const original = S3ObjectStorage.prototype.complete;
            S3ObjectStorage.prototype.complete = async function (...args) {
              await original.apply(this, args);
              throw Error('lost response');
            };
            try {
              await f.jobs.tick();
            } finally {
              S3ObjectStorage.prototype.complete = original;
            }
            assert.equal((await f.row(id)).state, 'completing');
            assert(await store.storage.head((await f.row(id)).staging_key));
            await f.retry(id);
            assert.equal((await f.row(id)).state, 'validating');
            assert((await f.row(id)).bytes_verified_at);
            assert.equal((await reconcileFileCapacity(f.db.pool)).driftWorkspaces, 0);
          },
        );
        await scenario(
          'lost CopyObject response retains its capacity; retry publishes only a new verified immutable copy',
          async (f) => {
            const id = await f.upload();
            await f.jobs.complete(f.actor, id);
            const original = S3ObjectStorage.prototype.copy;
            S3ObjectStorage.prototype.copy = async function (...args) {
              await original.apply(this, args);
              throw Error('lost copy response');
            };
            try {
              await f.jobs.tick();
            } finally {
              S3ObjectStorage.prototype.copy = original;
            }
            const orphan = (await f.db.pool.query('SELECT object_key FROM file_object_copies'))
              .rows[0].object_key as string;
            assert(await store.storage.head(orphan));
            assert.equal((await reconcileFileCapacity(f.db.pool)).copyBytes, String(bytes.length));
            await f.retry(id);
            const r = await f.row(id);
            assert.equal(r.state, 'validating');
            assert.notEqual(r.final_key, orphan);
            await f.expire(id);
            await f.jobs.tick();
            assert.equal(await store.storage.head(orphan), null);
            assert(await store.storage.head(r.final_key));
            assert.equal((await reconcileFileCapacity(f.db.pool)).copyBytes, '0');
            assert.equal((await reconcileFileCapacity(f.db.pool)).stagingBytes, '0');
          },
        );
        await scenario(
          'lost SQL COMMIT acknowledgement does not double-charge finalization or deletion',
          async (f) => {
            const id = await f.upload(),
              before = await reconcileFileCapacity(f.db.pool);
            const original = f.jobs.boundary.transaction.bind(f.jobs.boundary);
            let fail = true;
            f.jobs.boundary.transaction = async function (work) {
              const result = await original(work);
              if (fail) {
                fail = false;
                throw Error('lost COMMIT acknowledgement');
              }
              return result;
            };
            await assert.rejects(f.jobs.complete(f.actor, id), /lost COMMIT/);
            assert.equal((await f.row(id)).state, 'completing');
            await f.jobs.complete(f.actor, id);
            await f.jobs.tick();
            assert.equal((await f.row(id)).state, 'validating');
            assert.equal(
              (await reconcileFileCapacity(f.db.pool)).reservedBytes,
              before.reservedBytes,
            );
            await f.jobs.cancel(f.actor, id);
            await f.expire(id);
            f.jobs.boundary.transaction = async function (work) {
              const result = await original(work);
              if ((await f.row(id)).state === 'deleted' && fail) {
                fail = false;
                throw Error('lost deletion COMMIT');
              }
              return result;
            };
            fail = true;
            await f.jobs.tick();
            assert.equal((await f.row(id)).state, 'deleted');
            await f.jobs.tick();
            const after = await reconcileFileCapacity(f.db.pool);
            assert.equal(after.reservedBytes, '0');
            assert.equal(after.driftWorkspaces, 0);
          },
        );
        await scenario(
          'lost DELETE response keeps reservations until absence is confirmed after restart',
          async (f) => {
            const id = await f.upload();
            await f.jobs.complete(f.actor, id);
            await f.jobs.tick();
            const r = await f.row(id);
            await f.jobs.cancel(f.actor, id);
            await f.expire(id);
            const before = await reconcileFileCapacity(f.db.pool);
            const original = S3ObjectStorage.prototype.delete;
            S3ObjectStorage.prototype.delete = async function (key) {
              await original.call(this, key);
              if (key === r.final_key) throw Error('lost DELETE response');
            };
            try {
              await f.jobs.tick();
            } finally {
              S3ObjectStorage.prototype.delete = original;
            }
            assert.equal(await store.storage.head(r.final_key), null);
            assert.equal((await f.row(id)).state, 'deleting');
            assert.equal(
              (await reconcileFileCapacity(f.db.pool)).reservedBytes,
              before.reservedBytes,
            );
            const restarted = new UploadService(f.db.pool, store.config);
            try {
              await f.expire(id);
              await restarted.tick();
              await restarted.tick();
            } finally {
              restarted.close();
            }
            assert.equal((await f.row(id)).state, 'deleted');
            assert.equal((await reconcileFileCapacity(f.db.pool)).reservedBytes, '0');
          },
        );
        await scenario(
          'actual worker process crash after copy recovers from SQL and collects the uncommitted object',
          async (f) => {
            const id = await f.upload();
            await f.jobs.complete(f.actor, id);
            const child = fork(fileURLToPath(import.meta.url), [], {
              env: { ...process.env, MEMORIA_FILE_RECOVERY_CHILD: '1' },
              stdio: ['ignore', 'ignore', 'pipe', 'ipc'],
              windowsHide: true,
            });
            let diagnostic = '';
            child.stderr?.on('data', (b) => {
              diagnostic += String(b);
            });
            try {
              const copied = once(child, 'message'),
                exited = once(child, 'exit');
              child.send({ url: f.db.url, config: store.config });
              const message = await Promise.race([
                copied,
                exited.then(() => {
                  throw Error('child exited before copy: ' + diagnostic);
                }),
                delay(30000, undefined, { ref: false }).then(() => {
                  throw Error('copy marker timeout');
                }),
              ]);
              assert.equal((message[0] as { copied: boolean }).copied, true);
              const copies = (await f.db.pool.query('SELECT object_key FROM file_object_copies'))
                .rows;
              assert.equal(copies.length, 1);
              assert(await store.storage.head(copies[0]!.object_key));
              child.kill('SIGKILL');
              await exited;
              await f.retry(id);
              assert.equal((await f.row(id)).state, 'validating');
              await f.expire(id);
              await f.jobs.tick();
              assert.equal(await store.storage.head(copies[0]!.object_key), null);
              assert.equal((await reconcileFileCapacity(f.db.pool)).copyBytes, '0');
            } finally {
              if (child.exitCode === null && child.signalCode === null) {
                child.kill('SIGKILL');
                await once(child, 'exit');
              }
            }
          },
        );
        await scenario(
          'old job resumes after losing its PostgreSQL lock: it cannot publish or overwrite the new epoch',
          async (f) => {
            const id = await f.upload();
            await f.jobs.complete(f.actor, id);
            const url = new URL(f.db.url);
            url.searchParams.set('application_name', 'memoria_stale_file_job');
            const pool = createDatabase(url.toString()).pool,
              old = new UploadService(pool, store.config);
            const entered = deferred(),
              release = deferred(),
              original = S3ObjectStorage.prototype.copy;
            let first = true;
            S3ObjectStorage.prototype.copy = async function (...args) {
              await original.apply(this, args);
              if (first) {
                first = false;
                entered.done();
                await release.promise;
              }
            };
            let pending: Promise<boolean> | undefined;
            try {
              pending = old.tick();
              await entered.promise;
              const killed = await f.db.pool.query(
                "SELECT pg_terminate_backend(a.pid) FROM pg_stat_activity a WHERE application_name='memoria_stale_file_job' AND EXISTS(SELECT 1 FROM pg_locks l WHERE l.pid=a.pid AND l.locktype='advisory' AND l.granted)",
              );
              assert.equal(killed.rowCount, 1);
              await f.retry(id);
              const winner = await f.row(id);
              assert.equal(winner.state, 'validating');
              release.done();
              await pending;
              const after = await f.row(id);
              assert.equal(after.final_key, winner.final_key);
              assert.equal(after.job_epoch, winner.job_epoch);
              assert.equal(after.state, 'validating');
              assert.equal(after.last_error, null);
              await f.expire(id);
              await f.jobs.tick();
              assert.equal((await reconcileFileCapacity(f.db.pool)).copyBytes, '0');
              assert(await store.storage.head(winner.final_key));
            } finally {
              release.done();
              await pending;
              S3ObjectStorage.prototype.copy = original;
              old.close();
              await pool.end();
            }
          },
        );
        await scenario(
          'global staging/total/copy budgets are atomic across tenants and counters can be audited/repaired',
          async (f) => {
            const limits = readFileLimits();
            const newWorkspace = async () => {
              const workspace = randomUUID(),
                page = randomUUID();
              await f.db.pool.query(
                "INSERT INTO workspaces(id,name,slug) VALUES($1,'Capacity test',$1::uuid::text)",
                [workspace],
              );
              const user = randomUUID(),
                session = randomUUID();
              await f.db.pool.query(
                "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Capacity test',$2,true)",
                [user, user + '@example.test'],
              );
              await f.db.pool.query(
                "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
                [session, user, randomUUID()],
              );
              await f.db.pool.query(
                "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
                [workspace, user],
              );
              await f.db.pool.query(
                "INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')",
                [workspace, user],
              );
              await f.db.pool.query(
                "INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'a0')",
                [page, workspace],
              );
              return { ...f.actor, workspace, page, user, session, key: user };
            };
            const second = await newWorkspace(),
              small = new FileBoundary(f.db.pool, {
                ...limits,
                stagingBytes: bytes.length,
                activeFiles: 10,
              });
            const request = () => ({
              bytes: bytes.length,
              name: 'capacity',
              idempotency: randomUUID(),
              checksum: sha(bytes),
            });
            const race = await Promise.allSettled([
              small.reserve(f.actor, request()),
              small.reserve(second, request()),
            ]);
            assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
            assert.match(
              String((race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason),
              /FILE_STAGING_CAPACITY/,
            );
            const cap = await reconcileFileCapacity(f.db.pool);
            assert.equal(cap.driftWorkspaces, 0);
            const total = new FileBoundary(f.db.pool, {
              ...limits,
              capacityBytes: Number(cap.reservedBytes) + Number(cap.stagingBytes),
              activeFiles: 10,
            });
            await assert.rejects(total.reserve(second, request()), /FILE_STORAGE_CAPACITY/);
            await f.db.pool.query('UPDATE file_workspace_usage SET reserved_bytes=0,files_count=0');
            assert.equal((await reconcileFileCapacity(f.db.pool)).driftWorkspaces, 1);
            const admittedWorkspace = (
              await f.db.pool.query('SELECT workspace_id FROM file_upload_intents')
            ).rows[0].workspace_id as string;
            const driftActor = admittedWorkspace === f.actor.workspace ? f.actor : second;
            await assert.rejects(
              new FileBoundary(f.db.pool, { ...limits, activeFiles: 10 }).reserve(
                driftActor,
                request(),
              ),
              /FILE_ACCOUNTING_DRIFT/,
            );
            const command = (args: string[]) =>
              spawnSync(
                process.execPath,
                [resolve('apps/worker/dist/file-accounting.mjs'), ...args],
                {
                  env: { ...process.env, DATABASE_URL: f.db.url },
                  encoding: 'utf8',
                  windowsHide: true,
                  timeout: 20000,
                },
              );
            const audit = command([]);
            assert.equal(audit.status, 1, audit.stderr);
            assert.equal(JSON.parse(audit.stdout).driftWorkspaces, 1);
            const repair = command(['--repair']);
            assert.equal(repair.status, 0, repair.stderr);
            assert.equal(JSON.parse(repair.stdout).repaired, 1);
            assert.equal((await reconcileFileCapacity(f.db.pool)).driftWorkspaces, 0);
            assert.equal((await reconcileFileCapacity(f.db.pool)).reservedBytes, cap.reservedBytes);
          },
        );
        await scenario(
          'copy capacity denial leaves SQL and S3 unchanged and resumes after capacity is available',
          async (f) => {
            const id = await f.upload();
            await f.jobs.complete(f.actor, id);
            const low = new UploadService(f.db.pool, store.config, {
              ...readFileLimits(),
              copyBytes: bytes.length - 1,
            });
            try {
              await low.tick();
            } finally {
              low.close();
            }
            assert.equal((await f.row(id)).last_error, 'FILE_COPY_CAPACITY');
            assert.equal((await f.db.pool.query('SELECT 1 FROM file_object_copies')).rowCount, 0);
            await f.retry(id);
            assert.equal((await f.row(id)).state, 'validating');
            assert.equal((await reconcileFileCapacity(f.db.pool)).driftWorkspaces, 0);
          },
        );
      } finally {
        await store.close();
      }
    },
  );
