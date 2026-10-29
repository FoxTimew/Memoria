import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { storageFixture } from './testing/storage-fixture.ts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { UploadService } from '@memoria/storage/uploads';
import { S3ObjectStorage } from '@memoria/storage';
import { FilesController } from './modules/files/files.controller.ts';
import { FilesService } from './modules/files/files.service.ts';
import { reconcileFileCapacity } from '@memoria/db';
import { FILE_QUOTA } from './modules/files/file-quota.ts';
import { IS_PUBLIC } from './modules/auth/public.decorator.ts';
import { ipKey } from '@memoria/auth';
import { assertFileRouteMatrix } from './testing/file-route-matrix.ts';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
type Signature = {
  number: number;
  url?: string;
  headers?: Record<string, string>;
  post?: { url: string; fields: Record<string, string> };
  expiresAt: string;
};
async function put(s: Signature, bytes: Uint8Array) {
  if (s.post) {
    const form = new FormData();
    for (const [k, v] of Object.entries(s.post.fields)) form.append(k, v);
    form.append('file', new Blob([Uint8Array.from(bytes)]), 'asset');
    return fetch(s.post.url, { method: 'POST', body: form });
  }
  return fetch(s.url!, {
    method: 'PUT',
    headers: { ...s.headers, 'content-length': String(bytes.length) },
    body: Uint8Array.from(bytes),
  });
}
await test(
  '7a R12 upload routes and object GC on real Nest, PostgreSQL and unpatched RustFS',
  { timeout: 180000 },
  async (t) => {
    process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
    const store = await storageFixture(),
      h = await databaseHttpFixture(),
      db = h.f.db.pool;
    const jobs = new UploadService(db, store.config);
    const owner = await h.account('owner'),
      other = await h.account('member'),
      guest = await h.account('guest');
    const base = `/api/internal/workspaces/${h.f.db.workspace}/file-uploads`,
      pageId = h.f.rows[0]!;
    const call = (
      who: typeof owner | undefined,
      body: unknown = {},
      tail = '',
      method = 'POST',
      headers: Record<string, string> = {},
    ) => h.call(who, body, base + tail, headers, method);
    const bytes = Buffer.alloc(1024, 23),
      checksum = sha(bytes);
    const start = async (who = owner, p = pageId, data = bytes) => {
      const r = await call(who, {
        pageId: p,
        bytes: data.length,
        name: 'private-name-canary',
        checksum: sha(data),
        idempotency: randomUUID(),
      });
      assert.equal(r.status, 201, JSON.stringify(r.data));
      return String(r.data.id);
    };
    const sign = async (
      id: string,
      data = bytes,
      who = owner,
      parts = [{ number: 1, bytes: data.length, checksum: sha(data) }],
    ) => call(who, { request: randomUUID(), parts }, `/${id}/parts`);
    const row = async (id: string) =>
      (
        await db.query(
          'SELECT f.*,i.* FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.id=$1',
          [id],
        )
      ).rows[0];
    const finish = async (id: string) => {
      const r = await call(owner, {}, `/${id}/complete`);
      assert.equal(r.status, 202, JSON.stringify(r.data));
      await jobs.tick();
      const current = await row(id);
      assert.equal(current.state, 'validating', current.last_error);
      assert(current.bytes_verified_at);
      return current;
    };
    try {
      await t.test(
        'global capacity fails before allocation; accounting drift is refused without leaking tenant data',
        async () => {
          const limits = h.app.get(FilesService).transport.limits;
          const cap = limits.capacityBytes;
          const input = {
            pageId,
            bytes: bytes.length,
            name: 'capacity fixture',
            checksum,
            idempotency: randomUUID(),
          };
          const count = () =>
            db
              .query('SELECT count(*) FROM file_upload_intents')
              .then((r) => Number(r.rows[0].count));
          const before = await count();
          try {
            limits.capacityBytes = 1;
            const denied = await call(owner, input);
            assert.equal(denied.status, 429);
            assert.equal(denied.headers.get('retry-after'), '1');
            assert.deepEqual(denied.data, { code: 'FILE_STORAGE_CAPACITY' });
            assert.equal(await count(), before);
          } finally {
            limits.capacityBytes = cap;
          }
          await db.query(
            'INSERT INTO file_workspace_usage(workspace_id,reserved_bytes,files_count) VALUES($1,1,0) ON CONFLICT(workspace_id) DO UPDATE SET reserved_bytes=file_workspace_usage.reserved_bytes+1',
            [h.f.db.workspace],
          );
          const drift = await call(owner, input);
          assert.equal(drift.status, 503);
          assert.deepEqual(drift.data, { code: 'FILE_ACCOUNTING_DRIFT' });
          assert.equal(await count(), before);
          assert.equal((await reconcileFileCapacity(db, true)).repaired, 1);
          assert.equal((await reconcileFileCapacity(db)).driftWorkspaces, 0);
        },
      );
      await t.test(
        'U/P/L: all routes are guarded, quota classified, CSRF checked, bodies bounded',
        async () => {
          assertFileRouteMatrix(FilesController, {
            initiate: 'U',
            status: 'L',
            pending: 'L',
            resume: 'U',
            sign: 'P',
            complete: 'U',
            cancel: 'U',
          });
          const proto = FilesController.prototype;
          for (const [method, family] of [
            ['initiate', 'U'],
            ['status', 'L'],
            ['pending', 'L'],
            ['resume', 'U'],
            ['sign', 'P'],
            ['complete', 'U'],
            ['cancel', 'U'],
          ] as const) {
            assert.equal(Reflect.getMetadata(FILE_QUOTA, proto[method]), family);
            assert.notEqual(Reflect.getMetadata(IS_PUBLIC, proto[method]), true);
          }
          const id = randomUUID();
          for (const [tail, method] of [
            ['', 'POST'],
            ['/pending', 'POST'],
            [`/${id}`, 'GET'],
            [`/${id}/resume`, 'POST'],
            [`/${id}/parts`, 'POST'],
            [`/${id}/complete`, 'POST'],
            [`/${id}`, 'DELETE'],
          ])
            assert.equal((await call(undefined, {}, tail, method)).status, 401);
          assert.equal(
            (
              await fetch(h.origin + base + '/' + id, {
                method: 'HEAD',
                headers: { origin: h.config.APP_ORIGIN },
              })
            ).status,
            401,
          );
          assert.equal(
            (await call(owner, {}, '', 'POST', { origin: 'https://evil.invalid' })).status,
            403,
          );
          assert.equal((await call(owner, { padding: 'x'.repeat(65536) })).status, 413);
          assert.equal((await call(owner, {}, '/' + id, 'PATCH')).status, 404);
        },
      );
      let id = '',
        cap: Signature,
        verified: Awaited<ReturnType<typeof row>>;
      await t.test(
        'guest read cannot upload; owner idempotence and opaque ownership resist UUID swaps',
        async () => {
          const body = {
            pageId,
            bytes: bytes.length,
            name: 'private-name-canary',
            checksum,
            idempotency: randomUUID(),
          };
          assert.equal((await call(guest, body)).status, 404);
          const a = await call(owner, body);
          assert.equal(a.status, 201, JSON.stringify(a.data));
          id = String(a.data.id);
          const pending = await call(owner, { pageId }, '/pending');
          assert.equal(pending.status, 200);
          assert.equal((pending.data.items as { id: string }[])[0]?.id, id);
          assert.deepEqual((await call(other, { pageId }, '/pending')).data.items, []);
          assert.deepEqual((await call(owner, { pageId: h.f.rows[1] }, '/pending')).data.items, []);
          assert.equal((await call(guest, { pageId }, '/pending')).status, 404);
          assert.equal((await call(owner, body)).data.id, id);
          assert.equal(
            (await call(owner, { ...body, checksum: sha(Buffer.alloc(bytes.length, 7)) })).status,
            409,
          );
          for (const [tail, method] of [
            [`/${id}`, 'GET'],
            [`/${id}/parts`, 'POST'],
            [`/${id}/resume`, 'POST'],
            [`/${id}/complete`, 'POST'],
            [`/${id}`, 'DELETE'],
          ]) {
            const r = await call(other, {}, tail, method);
            assert.equal(r.status, 404);
            assert(!JSON.stringify(r.data).includes('private-name-canary'));
          }
          const wrong = await h.call(
            owner,
            {},
            `/api/internal/workspaces/${randomUUID()}/file-uploads/${id}`,
            {},
            'GET',
          );
          assert.equal(wrong.status, 404);
        },
      );
      await t.test(
        'direct POST has exact size; final bytes are checked and staged replay cannot change the immutable copy',
        async () => {
          const response = await sign(id);
          assert.equal(response.status, 200, JSON.stringify(response.data));
          cap = (response.data.signatures as Signature[])[0]!;
          assert((await put(cap, bytes)).ok);
          verified = await finish(id);
          assert.equal(verified.sha256, createHash('sha256').update(bytes).digest('hex'));
          assert.equal((await call(owner, {}, `/${id}/complete`)).status, 202);
          assert((await put(cap, Buffer.alloc(bytes.length, 99))).ok);
          const currentHash = createHash('sha256');
          for await (const b of await store.storage.read(verified.final_key)) currentHash.update(b);
          assert.equal(currentHash.digest('hex'), verified.sha256);
          assert.equal((await sign(id)).status, 409);
        },
      );
      await t.test(
        'false checksum never becomes ready; GC retains quota until capabilities and in-flight deadline end',
        async () => {
          const bad = await start(),
            s = await sign(bad);
          assert.equal(s.status, 200);
          assert(
            (await put((s.data.signatures as Signature[])[0]!, Buffer.alloc(bytes.length, 7))).ok,
          );
          assert.equal((await call(owner, {}, `/${bad}/complete`)).status, 202);
          await jobs.tick();
          assert.equal((await row(bad)).state, 'rejected');
          await jobs.tick();
          assert.equal((await row(bad)).state, 'rejected');
          await db.query(
            "UPDATE file_upload_intents SET expires_at=now()-interval '1 second' WHERE file_id=$1",
            [bad],
          );
          await jobs.tick();
          assert.equal((await row(bad)).state, 'deleting');
          const quota = (await db.query('SELECT reserved_bytes FROM file_workspace_usage')).rows[0]
            .reserved_bytes;
          assert(Number(quota) > 0);
          assert.equal((await row(bad)).storage_deleted_at, null);
          // Deliberate fixture clock advancement; the real 120s signature expiration is covered by conformance.
          await db.query(
            "UPDATE file_part_leases SET expires_at=now()-interval '121 seconds' WHERE file_id=$1",
            [bad],
          );
          await db.query('UPDATE file_upload_intents SET next_attempt_at=now() WHERE file_id=$1', [
            bad,
          ]);
          await jobs.tick();
          assert.equal((await row(bad)).state, 'deleted');
          assert(
            Number(
              (await db.query('SELECT reserved_bytes FROM file_workspace_usage')).rows[0]
                .reserved_bytes,
            ) < Number(quota),
          );
          await jobs.tick();
          assert.equal((await row(bad)).state, 'deleted');
        },
      );
      await t.test(
        'multipart resumes from the server, refuses client ETags and verifies every byte',
        async () => {
          // Free the completed fixture's active-upload place; type validation belongs to 7b.
          await db.query('UPDATE file_upload_intents SET closed_at=now() WHERE file_id=$1', [id]);
          const data = Buffer.alloc(33 * 1024 ** 2, 31),
            m = await start(owner, pageId, data);
          const parts = [0, 1, 2].map((i) => ({
            number: i + 1,
            bytes: Math.min(16 * 1024 ** 2, data.length - i * 16 * 1024 ** 2),
            checksum: sha(
              data.subarray(i * 16 * 1024 ** 2, Math.min(data.length, (i + 1) * 16 * 1024 ** 2)),
            ),
          }));
          const r = await sign(m, data, owner, parts);
          assert.equal(r.status, 200, JSON.stringify(r.data));
          const signed = r.data.signatures as Signature[];
          for (let i = 0; i < signed.length; i++)
            assert(
              (
                await put(
                  signed[i]!,
                  data.subarray(
                    i * 16 * 1024 ** 2,
                    Math.min(data.length, (i + 1) * 16 * 1024 ** 2),
                  ),
                )
              ).ok,
            );
          const resumed = await call(owner, {}, `/${m}/resume`);
          assert.equal(resumed.status, 200);
          assert.equal((resumed.data.parts as unknown[]).length, 3);
          assert.equal(
            (await call(owner, { parts: [{ etag: 'invented' }] }, `/${m}/complete`)).status,
            400,
          );
          const completed = await finish(m);
          assert.equal(completed.sha256, createHash('sha256').update(data).digest('hex'));
        },
      );
      await t.test(
        'actual access revocation is rechecked after S3; no new capability or publication',
        async () => {
          await db.query(
            "UPDATE access_grants SET level='edit' WHERE subject_id IN (SELECT id FROM access_subjects WHERE member_id IN (SELECT id FROM workspace_members WHERE user_id=$1))",
            [guest.user],
          );
          const g = await start(guest),
            signed = await sign(g, bytes, guest);
          assert.equal(signed.status, 200);
          assert((await put((signed.data.signatures as Signature[])[0]!, bytes)).ok);
          assert.equal((await call(guest, {}, `/${g}/complete`)).status, 202);
          await db.query(
            "UPDATE access_grants SET level='read' WHERE subject_id IN (SELECT id FROM access_subjects WHERE member_id IN (SELECT id FROM workspace_members WHERE user_id=$1))",
            [guest.user],
          );
          assert.equal((await sign(g, bytes, guest)).status, 404);
          await jobs.tick();
          assert.equal((await row(g)).state, 'rejected');
        },
      );
      await t.test(
        'cleanup preserves the immutable final, retained usages and the orphan retention window',
        async () => {
          await db.query(
            "UPDATE file_part_leases SET expires_at=now()-interval '121 seconds' WHERE file_id=$1",
            [id],
          );
          await db.query('UPDATE file_upload_intents SET next_attempt_at=now() WHERE file_id=$1', [
            id,
          ]);
          for (let i = 0; i < 8 && !(await row(id)).staging_cleaned_at; i++) await jobs.tick();
          assert((await row(id)).staging_cleaned_at);
          assert.equal(await store.storage.head(verified.staging_key), null);
          assert(await store.storage.head(verified.final_key));
          // The decoder is deliberately outside 7a: set this fixture ready, never the application.
          await db.query("UPDATE files SET state='ready' WHERE id=$1", [id]);
          const usage = randomUUID();
          await db.query(
            "INSERT INTO file_usages(id,workspace_id,page_id,slot_kind,slot_id,file_id,generation,revision) VALUES($1,$2,$3,'block',$4,$5,$6,1)",
            [usage, h.f.db.workspace, pageId, randomUUID(), id, randomUUID()],
          );
          await db.query(
            "UPDATE file_upload_intents SET attach_until=now()-interval '40 days' WHERE file_id=$1",
            [id],
          );
          await jobs.tick();
          assert.equal((await row(id)).state, 'ready');
          const c = await db.connect();
          await c.query('BEGIN');
          await c.query('DELETE FROM file_usages WHERE id=$1', [usage]);
          await c.query('ROLLBACK');
          c.release();
          assert.equal((await row(id)).orphaned_at, null);
          await db.query('DELETE FROM file_usages WHERE id=$1', [usage]);
          await jobs.tick();
          assert.equal((await row(id)).state, 'ready');
          await db.query("UPDATE files SET orphaned_at=now()-interval '31 days' WHERE id=$1", [id]);
          for (let i = 0; i < 8 && (await row(id)).state !== 'deleted'; i++) await jobs.tick();
          assert.equal((await row(id)).state, 'deleted');
          assert.equal(await store.storage.head(verified.final_key), null);
          const usageBefore = (
            await db.query('SELECT reserved_bytes,files_count FROM file_workspace_usage')
          ).rows;
          assert.equal((await call(owner, {}, `/${id}`, 'DELETE')).status, 202);
          await jobs.tick();
          assert.deepEqual(
            (await db.query('SELECT reserved_bytes,files_count FROM file_workspace_usage')).rows,
            usageBefore,
          );
        },
      );
      await t.test(
        'every upload route rejects recovery-only sessions and enforced workspace MFA',
        async () => {
          const endpoints = [
            ['', 'POST'],
            [`/${id}`, 'GET'],
            [`/${id}/resume`, 'POST'],
            [`/${id}/parts`, 'POST'],
            [`/${id}/complete`, 'POST'],
            [`/${id}`, 'DELETE'],
          ];
          await db.query(
            "INSERT INTO session_assurance(session_id,method,verified_at,security_version) VALUES($1,'recovery',now(),0)",
            [owner.session],
          );
          for (const [tail, method] of endpoints)
            assert.equal((await call(owner, {}, tail, method)).status, 403);
          await db.query('DELETE FROM session_assurance WHERE session_id=$1', [owner.session]);
          await db.query(
            'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())',
            [h.f.db.workspace],
          );
          for (const [tail, method] of endpoints) {
            const body =
              tail === ''
                ? {
                    pageId,
                    bytes: bytes.length,
                    name: 'fixture',
                    checksum,
                    idempotency: randomUUID(),
                  }
                : tail?.endsWith('/parts')
                  ? { request: randomUUID(), parts: [{ number: 1, bytes: bytes.length, checksum }] }
                  : {};
            assert.equal((await call(owner, body, tail, method)).status, 404);
          }
          await db.query('DELETE FROM workspace_policies WHERE workspace_id=$1', [
            h.f.db.workspace,
          ]);
        },
      );
      await t.test(
        'SDK error canaries do not escape HTTP, retry logs, audit or outbox',
        async () => {
          const canary = 'SENSITIVE-' + randomUUID();
          const message = `https://store.invalid/private/${canary}?X-Amz-Signature=${canary}`;
          const logs: string[] = [];
          const warn = console.warn,
            error = console.error;
          console.warn = (...args: unknown[]) => {
            logs.push(JSON.stringify(args));
            warn(...args);
          };
          console.error = (...args: unknown[]) => {
            logs.push(JSON.stringify(args));
            error(...args);
          };
          const transport = h.app.get(FilesService).transport;
          const create = transport.storage.createUpload.bind(transport.storage);
          const head = S3ObjectStorage.prototype.head;
          try {
            const file = await start();
            transport.storage.createUpload = async () => {
              throw Error(message);
            };
            const denied = await sign(file);
            assert.equal(denied.status, 503);
            assert.deepEqual(denied.data, { code: 'STORAGE_UNAVAILABLE', retryAfter: 2 });
            assert(!JSON.stringify(denied.data).includes(canary));
            transport.storage.createUpload = create;
            const signed = await sign(file);
            assert.equal(signed.status, 200);
            assert((await put((signed.data.signatures as Signature[])[0]!, bytes)).ok);
            assert.equal((await call(owner, {}, `/${file}/complete`)).status, 202);
            // Choose only this job in this isolated schema; leave production scheduling unchanged.
            await db.query(
              "UPDATE file_upload_intents SET next_attempt_at=clock_timestamp()+interval '1 hour' WHERE file_id<>$1",
              [file],
            );
            S3ObjectStorage.prototype.head = async () => {
              throw Error(message);
            };
            await jobs.tick();
            assert.equal((await row(file)).last_error, 'STORAGE_UNAVAILABLE');
            const status = await call(owner, {}, `/${file}`, 'GET');
            assert.equal(status.status, 200);
            assert(!JSON.stringify(status.data).includes(canary));
            assert(logs.some((line) => line.includes('file_job_retry')));
            assert(!logs.join('\n').includes(canary));
            const audit = await db.query('SELECT to_jsonb(a) AS entry FROM audit_logs a');
            assert(!JSON.stringify(audit.rows).includes(canary));
            const outbox = await db.query('SELECT to_jsonb(e) AS entry FROM outbox_events e');
            assert(!JSON.stringify(outbox.rows).includes(canary));
          } finally {
            transport.storage.createUpload = create;
            S3ObjectStorage.prototype.head = head;
            console.warn = warn;
            console.error = error;
          }
        },
      );
      await t.test('quotas aggregate sessions and ignore forged proxy headers', async () => {
        // Use the same quota engine and real HTTP route; reaching the budget is expected in this attack.
        let limited = 0;
        for (let i = 0; i < 125; i++) {
          const r = await call(owner, {}, `/${id}`, 'GET', {
            'x-forwarded-for': '192.0.2.' + ((i % 200) + 1),
            'x-memoria-client-ip': '198.51.100.' + ((i % 200) + 1),
          });
          if (r.status === 429) {
            limited++;
            assert(r.headers.get('retry-after'));
          }
        }
        assert(limited > 0);
        assert.equal((await call(other, {}, `/${id}`, 'GET')).status, 404);
        const ip = ipKey(h.config.BETTER_AUTH_SECRET, 'files:L', '127.0.0.1');
        assert(
          Number(
            (await db.query('SELECT count FROM auth_buckets WHERE key=$1', [ip])).rows[0]?.count,
          ) >= 125,
        );
        for (const address of ['192.0.2.1', '198.51.100.1'])
          assert.equal(
            (
              await db.query('SELECT 1 FROM auth_buckets WHERE key=$1', [
                ipKey(h.config.BETTER_AUTH_SECRET, 'files:L', address),
              ])
            ).rowCount,
            0,
          );
        // Saturate the authentic IP bucket in the fixture, then attempt to escape via forged headers.
        await db.query('UPDATE auth_buckets SET count=6000 WHERE key=$1', [ip]);
        assert.equal(
          (
            await call(other, {}, `/${id}`, 'GET', {
              'x-forwarded-for': '192.0.2.201',
              'x-memoria-client-ip': '198.51.100.201',
            })
          ).status,
          429,
        );
      });
    } finally {
      jobs.close();
      await h.close();
      await store.close();
    }
  },
);
