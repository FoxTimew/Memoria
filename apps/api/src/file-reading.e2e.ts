import 'reflect-metadata';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash, randomUUID, randomBytes, createCipheriv, createDecipheriv } from 'node:crypto';
import { readFile, writeFile, rename } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { resolve } from 'node:path';
import { request as httpRequest } from 'node:http';
import { setTimeout as delay } from 'node:timers/promises';
import { storageFixture } from './testing/storage-fixture.ts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { UploadService } from '@memoria/storage/uploads';
import { S3ObjectStorage } from '@memoria/storage';
import { FileValidator } from '@memoria/storage/validate';
import { ReadTickets } from '@memoria/storage/read-ticket';
import { exportFiles, verifyFilesBackup, restoreFiles } from '@memoria/storage/backup';
import { createDatabase, FileCells, FileReading, reconcileFileCapacity } from '@memoria/db';
import { fileGateway } from '../../files/src/gateway.ts';
import { imageId, imageFixture } from '../../../scripts/file-image-fixture.mjs';
import { guardTestDocker } from '../../../scripts/docker-test-isolation.mjs';
import { FileReadController } from './modules/files/read.controller.ts';
import { FILE_QUOTA } from './modules/files/file-quota.ts';
import { IS_PUBLIC } from './modules/auth/public.decorator.ts';
import { ipKey, throttleKey } from '@memoria/auth';
const sha = (b: Uint8Array) => createHash('sha256').update(b).digest('base64');
await test(
  '7b real decoder, RustFS, guarded Nest and revocable HTTP gateway',
  { timeout: 240000 },
  async (t) => {
    process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
    const store = await storageFixture(),
      h = await databaseHttpFixture(),
      db = h.f.db.pool;
    const owner = await h.account('owner'),
      guest = await h.account('guest'),
      stranger = await h.account('guest', false);
    const gatewayName = 'file-gateway-test-' + randomUUID(),
      gatewayDbUrl = new URL(h.f.db.url);
    gatewayDbUrl.searchParams.set('application_name', gatewayName);
    const connection = createDatabase(gatewayDbUrl.toString(), { max: 8, timeout: 1500 });
    const g = await fileGateway({
      ...connection,
      storage: store.storage,
      secret: h.config.BETTER_AUTH_SECRET,
      origin: h.config.APP_ORIGIN,
      trustedProxy: ['10.255.255.0/24'],
    });
    const server = g.app.listen(0, '127.0.0.1');
    await new Promise<void>((r) => server.once('listening', r));
    const address = server.address();
    assert(address && typeof address !== 'string');
    const origin = 'http://127.0.0.1:' + address.port;
    const jobs = new UploadService(db, store.config),
      validator = new FileValidator(jobs, {
        image: imageId(),
        directory: resolve('.local/validator-integration-' + randomUUID()),
        guard: guardTestDocker,
      });
    const page = h.f.rows[0]!,
      workspace = h.f.db.workspace,
      property = randomUUID();
    const fileBase = `/api/internal/workspaces/${workspace}/files`,
      uploadBase = `/api/internal/workspaces/${workspace}/file-uploads`;
    const source = await imageFixture(),
      cells = new FileCells(db);
    await db.query(
      "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position) VALUES($1,$2,$3,'assets','Assets','files','a8')",
      [property, workspace, h.f.bases[0]],
    );
    const fileRow = async (id: string) =>
      (await db.query('SELECT * FROM files WHERE id=$1', [id])).rows[0];
    const upload = async (data: Uint8Array, name: string, validate = true) => {
      const r = await h.call(
        owner,
        { pageId: page, bytes: data.length, name, checksum: sha(data), idempotency: randomUUID() },
        uploadBase,
      );
      assert.equal(r.status, 201, JSON.stringify(r.data));
      const id = String(r.data.id);
      const signed = await h.call(
        owner,
        { request: randomUUID(), parts: [{ number: 1, bytes: data.length, checksum: sha(data) }] },
        `${uploadBase}/${id}/parts`,
      );
      assert.equal(signed.status, 200, JSON.stringify(signed.data));
      const part = (
        signed.data.signatures as { post: { url: string; fields: Record<string, string> } }[]
      )[0]!;
      const form = new FormData();
      for (const [k, v] of Object.entries(part.post.fields)) form.append(k, v);
      form.append('file', new Blob([Uint8Array.from(data)]), 'fake.html');
      assert.equal((await fetch(part.post.url, { method: 'POST', body: form })).status, 204);
      assert.equal((await h.call(owner, {}, `${uploadBase}/${id}/complete`)).status, 202);
      for (let i = 0; i < 10 && (await fileRow(id)).state === 'completing'; i++) await jobs.tick();
      assert.equal((await fileRow(id)).state, 'validating');
      if (validate) await validator.tick();
      return id;
    };
    let cellVersion = '0';
    const attach = async (id: string) => {
      const version = (
        await db.query('SELECT schema_version FROM databases WHERE id=$1', [h.f.bases[0]])
      ).rows[0].schema_version;
      const r = await cells.write(
        { ...owner, key: 'attach', page, rowScope: { database: h.f.bases[0]! } },
        property,
        String(version),
        cellVersion,
        { add: [id], remove: [] },
      );
      cellVersion = String(r.version);
    };
    const ticket = async (id: string, variant = 'original', who = owner, p = page) => {
      const r = await h.call(
        who,
        { pageId: p, files: [{ id, variant }] },
        fileBase + '/read-tickets',
      );
      assert.equal(r.status, 200, JSON.stringify(r.data));
      const url = (r.data.items as { url: string }[])[0]?.url;
      return url ? origin + new URL(url).pathname : undefined;
    };
    let raster = '',
      active = '',
      large = '';
    const slow = async (url: string) => {
      const response = await new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
        const req = httpRequest(url, (r) => {
          r.pause();
          r.on('error', () => {});
          resolve(r);
        });
        req.on('error', reject);
        req.end();
      });
      assert.equal(response.statusCode, 200);
      return response;
    };
    const drained = async (expected: number) => {
      const began = performance.now();
      while (g.active() !== expected && performance.now() - began < 5000) await delay(25);
      assert.equal(g.active(), expected);
      assert(performance.now() - began < 5000);
    };
    try {
      await t.test(
        'all four control routes have quotas and default authentication; no CSRF/recovery bypass',
        async () => {
          for (const [method, family] of [
            ['resolve', 'L'],
            ['tickets', 'L'],
            ['archive', 'M'],
            ['restore', 'M'],
          ] as const) {
            const fn = FileReadController.prototype[method];
            assert.equal(Reflect.getMetadata(FILE_QUOTA, fn), family);
            assert.notEqual(Reflect.getMetadata(IS_PUBLIC, fn), true);
          }
          for (const tail of [
            '/resolve',
            '/read-tickets',
            '/' + randomUUID() + '/archive',
            '/' + randomUUID() + '/restore',
          ]) {
            assert.equal((await h.call(undefined, {}, fileBase + tail)).status, 401);
            assert.equal(
              (await h.call(owner, {}, fileBase + tail, { origin: 'https://attacker.invalid' }))
                .status,
              403,
            );
          }
          await db.query(
            "INSERT INTO session_assurance(session_id,method,verified_at,security_version) VALUES($1,'recovery',now(),0)",
            [stranger.session],
          );
          assert.notEqual(
            (await h.call(stranger, { pageId: page, files: [] }, fileBase + '/resolve')).status,
            200,
          );
        },
      );
      await t.test(
        'real type ignores name/MIME; EXIF/GPS raster reencoded, active original download-only',
        async () => {
          raster = await upload(
            await readFile(resolve(source, 'exif.jpg')),
            'private-name-canary.html',
          );
          assert.equal((await fileRow(raster)).state, 'ready');
          assert.equal((await fileRow(raster)).mime_type, 'image/jpeg');
          await attach(raster);
          active = await upload(await readFile(resolve(source, 'active.svg')), 'fake-image.jpg');
          assert.equal((await fileRow(active)).preview_status, 'unsupported');
          await attach(active);
          assert.equal(await ticket(active, 'display'), undefined);
          const url = await ticket(active);
          assert(url);
          const r = await fetch(url);
          assert.equal(r.status, 200);
          assert.match(r.headers.get('content-disposition')!, /^attachment/);
          assert.equal(r.headers.get('content-type'), 'application/octet-stream');
          assert.equal(r.headers.get('x-content-type-options'), 'nosniff');
          assert.match(r.headers.get('content-security-policy')!, /sandbox/);
          assert.match(r.headers.get('cache-control')!, /no-store/);
          await r.arrayBuffer();
          const display = await ticket(raster, 'display');
          assert(display);
          const shown = await fetch(display);
          assert.equal(shown.headers.get('content-type'), 'image/webp');
          const b = Buffer.from(await shown.arrayBuffer());
          assert.equal(b.subarray(8, 12).toString(), 'WEBP');
          for (const marker of ['EXIF', 'GPSLatitude', 'PRIVATE_ARTIST'])
            assert(!b.includes(Buffer.from(marker)));
          assert.equal((await reconcileFileCapacity(db)).driftWorkspaces, 0);
        },
      );
      await t.test(
        'encrypted local PG/object backup: missing/corrupt data blocks restoration; sessions revoked',
        async () => {
          // Fixture is quiescent: no incoming writes or background jobs, gateway only probes SELECT 1.
          const directory = resolve('.local/files-backup-' + randomUUID()),
            key = randomBytes(32);
          const saved = await exportFiles(db, store.storage, directory, key);
          assert.equal(saved.objects, 4);
          const pgContainer = execFileSync('docker', ['compose', 'ps', '-q', 'postgres'], {
            encoding: 'utf8',
            windowsHide: true,
          }).trim();
          assert(/^[a-f0-9]{12,64}$/.test(pgContainer));
          const sourceUrl = new URL(h.f.db.url);
          const dump = execFileSync(
            'docker',
            [
              'exec',
              pgContainer,
              'pg_dump',
              '-U',
              decodeURIComponent(sourceUrl.username),
              '-d',
              sourceUrl.pathname.slice(1),
              '--schema',
              h.f.db.schema,
              '--no-owner',
              '--no-privileges',
              '--inserts',
            ],
            { windowsHide: true, maxBuffer: 16 * 1024 ** 2 },
          );
          const iv = randomBytes(12),
            cipher = createCipheriv('aes-256-gcm', key, iv),
            encrypted = Buffer.concat([cipher.update(dump), cipher.final()]);
          await writeFile(
            resolve(directory, 'postgres.bin'),
            Buffer.concat([iv, cipher.getAuthTag(), encrypted]),
            { flag: 'wx', mode: 0o600 },
          );
          await rename(resolve(directory, '0.bin'), resolve(directory, '0.missing'));
          await assert.rejects(verifyFilesBackup(directory, key));
          await rename(resolve(directory, '0.missing'), resolve(directory, '0.bin'));
          const original = await readFile(resolve(directory, '0.bin')),
            corrupt = Buffer.from(original);
          corrupt[0] = corrupt[0]! ^ 1;
          await writeFile(resolve(directory, '0.bin'), corrupt);
          await assert.rejects(verifyFilesBackup(directory, key));
          await writeFile(resolve(directory, '0.bin'), original);
          assert.equal((await verifyFilesBackup(directory, key)).length, 4);
          const target = await storageFixture(),
            schema = 'memoria_restore_test_' + randomUUID().replaceAll('-', '');
          let restored: ReturnType<typeof createDatabase> | undefined;
          try {
            assert.deepEqual(await restoreFiles(target.storage, directory, key), saved);
            await assert.rejects(
              restoreFiles(target.storage, directory, key),
              /RESTORE_TARGET_NOT_EMPTY/,
            );
            const decrypt = createDecipheriv('aes-256-gcm', key, iv);
            decrypt.setAuthTag(cipher.getAuthTag());
            const sql = Buffer.concat([decrypt.update(encrypted), decrypt.final()])
              .toString('utf8')
              .replaceAll(h.f.db.schema, schema)
              .split('\n')
              .filter((line) => !line.startsWith('\\'))
              .join('\n');
            const connection = await db.connect();
            try {
              await connection.query(sql);
            } finally {
              await connection.query('SET search_path TO ' + h.f.db.schema);
              connection.release();
            }
            const restoreUrl = new URL(h.f.db.url);
            restoreUrl.searchParams.set('options', '-c search_path=' + schema);
            restored = createDatabase(restoreUrl.toString());
            assert.equal(
              Number(
                (await restored.pool.query("SELECT count(*) n FROM files WHERE state='ready'"))
                  .rows[0].n,
              ),
              2,
            );
            assert.equal((await reconcileFileCapacity(restored.pool)).driftWorkspaces, 0);
            const claim = await new FileReading(db).issue(
              { key: 'backup', user: owner.user, session: owner.session, workspace, page },
              raster,
              'display',
            );
            assert(await new FileReading(restored.pool).authorize(claim));
            await restored.pool.query('DELETE FROM auth_sessions');
            await assert.rejects(
              new FileReading(restored.pool).authorize(claim),
              /FILE_UNAVAILABLE/,
            );
            // Replay an external deletion after the snapshot, before any reopening.
            await restored.pool.query(
              'UPDATE files SET deleted_at=clock_timestamp(),validation_version=validation_version+1 WHERE id=$1',
              [active],
            );
            assert(
              (await restored.pool.query('SELECT deleted_at FROM files WHERE id=$1', [active]))
                .rows[0].deleted_at,
            );
          } finally {
            await restored?.pool.end();
            await db.query('DROP SCHEMA IF EXISTS "' + schema + '" CASCADE');
            await target.close();
          }
        },
      );
      await t.test(
        'invalid raster rejected; dimensions over the limit stay download-only',
        async () => {
          const corrupt = await upload(
            Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 99, 0, 0, 0, 0, 0, 0]),
            'ok.jpg',
          );
          assert.equal((await fileRow(corrupt)).state, 'rejected');
          const wide = await upload(await readFile(resolve(source, 'wide.png')), 'wide.png');
          assert.equal((await fileRow(wide)).preview_status, 'dimensions');
          assert.equal((await fileRow(wide)).state, 'ready');
        },
      );
      await t.test(
        'late derivative job cannot publish; abandoned variants are collected even after staging cleanup',
        async () => {
          const id = await upload(await readFile(resolve(source, 'exif.jpg')), 'late.jpg', false);
          await db.query(
            "UPDATE file_part_leases SET expires_at=clock_timestamp()-interval '1 hour' WHERE file_id=$1",
            [id],
          );
          await db.query(
            'UPDATE file_upload_intents SET next_attempt_at=clock_timestamp() WHERE file_id=$1',
            [id],
          );
          await jobs.tick();
          assert(
            (
              await db.query(
                'SELECT staging_cleaned_at FROM file_upload_intents WHERE file_id=$1',
                [id],
              )
            ).rows[0].staging_cleaned_at,
          );
          const original = S3ObjectStorage.prototype.putDerivative;
          let changed = false;
          S3ObjectStorage.prototype.putDerivative = async function (...args) {
            await original.apply(this, args);
            if (!changed) {
              changed = true;
              // Fault injection after actual S3 write: another durable job epoch now owns publication.
              await db.query(
                'UPDATE file_upload_intents SET job_epoch=job_epoch+1 WHERE file_id=$1',
                [id],
              );
            }
          };
          try {
            await assert.rejects(() => validator.tick(), /STALE_VALIDATOR/);
          } finally {
            S3ObjectStorage.prototype.putDerivative = original;
          }
          assert.equal((await fileRow(id)).state, 'validating');
          assert.equal(
            (await db.query('SELECT 1 FROM file_variants WHERE file_id=$1', [id])).rowCount,
            0,
          );
          const obsolete = (
            await db.query(
              'SELECT object_key FROM file_object_copies WHERE file_id=$1 AND byte_size IS NOT NULL',
              [id],
            )
          ).rows;
          assert.equal(obsolete.length, 2);
          await jobs.tick();
          for (const row of obsolete) assert.equal(await store.storage.head(row.object_key), null);
          await validator.tick();
          assert.equal((await fileRow(id)).state, 'ready');
          const keys = (
            await db.query('SELECT object_key FROM file_variants WHERE file_id=$1', [id])
          ).rows;
          assert.equal(keys.length, 2);
          await jobs.tick();
          for (const row of keys) assert(await store.storage.head(row.object_key));
          // Expire this unattached test asset; GC must delete original and both published variants.
          await db.query(
            "UPDATE file_upload_intents SET attach_until=clock_timestamp()-interval '1 hour',next_attempt_at=clock_timestamp() WHERE file_id=$1",
            [id],
          );
          for (let i = 0; i < 10 && (await fileRow(id)).state !== 'deleted'; i++) await jobs.tick();
          assert.equal((await fileRow(id)).state, 'deleted');
          for (const row of keys) assert.equal(await store.storage.head(row.object_key), null);
          assert.equal((await reconcileFileCapacity(db)).driftWorkspaces, 0);
        },
      );
      await t.test(
        'inaccessible identifiers and cross-tenant pages reveal no metadata or read capability',
        async () => {
          const r = await h.call(
            guest,
            { pageId: h.f.rows[2], files: [raster, randomUUID()] },
            fileBase + '/resolve',
          );
          assert.deepEqual(r.data, { items: [], unavailable: true });
          const hidden = await h.call(
            owner,
            { pageId: randomUUID(), files: [{ id: raster, variant: 'original' }] },
            fileBase + '/read-tickets',
          );
          assert.deepEqual(hidden.data, { items: [], unavailable: true });
          const invalid = await h.call(
            owner,
            { pageId: page, files: [{ id: raster, variant: 'original', key: 'staging/evil' }] },
            fileBase + '/read-tickets',
          );
          assert.equal(invalid.status, 400);
        },
      );
      await t.test(
        'GET/HEAD/Range: modified/expired capabilities, query injection, CORS and methods',
        async () => {
          const url = await ticket(raster, 'original', guest);
          assert(url);
          const full = await fetch(url);
          const bytes = Buffer.from(await full.arrayBuffer());
          const part = await fetch(url, { headers: { range: 'bytes=2-6' } });
          assert.equal(part.status, 206);
          assert.deepEqual(Buffer.from(await part.arrayBuffer()), bytes.subarray(2, 7));
          assert.equal((await fetch(url, { method: 'HEAD' })).status, 200);
          for (const range of ['bytes=0-1,3-4', 'bytes=-0', 'bytes=99999999-'])
            assert.equal((await fetch(url, { headers: { range } })).status, 416);
          assert.equal((await fetch(url + '?response-content-type=text/html')).status, 400);
          assert.equal((await fetch(url, { method: 'POST' })).status, 405);
          assert.equal((await fetch(origin + '/v1/files/forged')).status, 401);
          assert.equal((await fetch(url.slice(0, -10) + 'AAAAA')).status, 401);
          const reading = new FileReading(db),
            claim = await reading.issue(
              { key: 'expiry', user: owner.user, session: owner.session, workspace, page },
              raster,
              'original',
            );
          const old = new ReadTickets(h.config.BETTER_AUTH_SECRET).issue(claim, Date.now() - 61000);
          assert.equal((await fetch(origin + '/v1/files/' + old)).status, 401);
          assert.equal(
            (await fetch(url, { method: 'OPTIONS', headers: { origin: 'https://evil.invalid' } }))
              .status,
            403,
          );
          const cors = await fetch(url, { headers: { origin: h.config.APP_ORIGIN } });
          assert.equal(cors.headers.get('access-control-allow-origin'), h.config.APP_ORIGIN);
          assert.equal(cors.headers.get('access-control-allow-credentials'), null);
          await cors.arrayBuffer();
        },
      );
      await t.test(
        'archive/restore CAS and guest denial; old ticket never reactivates',
        async () => {
          const url = await ticket(raster);
          assert(url);
          assert.equal(
            (await h.call(guest, { pageId: page, version: 1 }, `${fileBase}/${raster}/archive`))
              .status,
            403,
          );
          assert.equal(
            (await h.call(owner, { pageId: page, version: 1 }, `${fileBase}/${raster}/archive`))
              .status,
            200,
          );
          assert.equal((await fetch(url)).status, 404);
          assert.equal(
            (await h.call(owner, { pageId: page, version: 1 }, `${fileBase}/${raster}/restore`))
              .status,
            409,
          );
          assert.equal(
            (await h.call(owner, { pageId: page, version: 2 }, `${fileBase}/${raster}/restore`))
              .status,
            200,
          );
          assert.equal((await fetch(url)).status, 404);
          assert(await ticket(raster));
        },
      );
      await t.test(
        'forged forwarding headers do not escape IP nor account download budgets',
        async () => {
          const url = await ticket(raster);
          assert(url);
          const key = ipKey(h.config.BETTER_AUTH_SECRET, 'file-download', '127.0.0.1');
          await db.query('DELETE FROM auth_buckets');
          const { consumeBucket } = await import('@memoria/auth');
          await consumeBucket(connection.db, key, 1, 60);
          await db.query('UPDATE auth_buckets SET count=12000 WHERE key=$1', [key]);
          assert.equal(
            (await fetch(url, { headers: { 'x-forwarded-for': '198.51.100.55' } })).status,
            429,
          );
          await db.query('DELETE FROM auth_buckets');
          const account = throttleKey(
            h.config.BETTER_AUTH_SECRET,
            'file-download:account',
            owner.user,
          );
          await consumeBucket(connection.db, account, 1, 60);
          await db.query('UPDATE auth_buckets SET count=240 WHERE key=$1', [account]);
          assert.equal((await fetch(url)).status, 429);
          await db.query('DELETE FROM auth_buckets');
        },
      );
      await t.test(
        'real slow HTTP flow closes within five seconds after page reference withdrawal',
        async () => {
          large = await upload(Buffer.alloc(16 * 1024 ** 2, 41), 'large.bin');
          await attach(large);
          const url = await ticket(large, 'original', guest);
          assert(url);
          let closed = false;
          const response = await new Promise<import('node:http').IncomingMessage>(
            (resolve, reject) => {
              const req = httpRequest(url, (r) => {
                r.pause();
                r.on('error', () => {
                  closed = true;
                });
                r.on('close', () => {
                  closed = true;
                });
                resolve(r);
              });
              req.on('error', reject);
              req.end();
            },
          );
          assert.equal(response.statusCode, 200);
          assert(g.active() > 0);
          const began = performance.now();
          await db.query('DELETE FROM file_usages WHERE file_id=$1', [large]);
          while (g.active() > 0 && performance.now() - began < 5000) await delay(25);
          assert.equal(g.active(), 0);
          assert(performance.now() - began < 5000);
          response.resume();
          await delay(50);
          response.destroy();
          assert(closed || response.destroyed);
          assert.equal((await fetch(url)).status, 404);
          const unrelated = await ticket(raster, 'original', guest);
          assert(unrelated);
          assert.equal((await fetch(unrelated)).status, 200);
        },
      );
      await t.test(
        'lost file notification still closes an existing flow; read grant removal targets only the guest',
        async () => {
          await attach(large);
          const first = await ticket(large, 'original', guest);
          assert(first);
          const paused = await slow(first);
          await db.query('ALTER TABLE file_usages DISABLE TRIGGER file_read_usage');
          try {
            await db.query('DELETE FROM file_usages WHERE file_id=$1', [large]);
            await drained(0);
          } finally {
            await db.query('ALTER TABLE file_usages ENABLE TRIGGER file_read_usage');
            paused.destroy();
          }
          await attach(large);
          const guestUrl = await ticket(large, 'original', guest),
            ownerUrl = await ticket(large);
          assert(guestUrl && ownerUrl);
          const guestStream = await slow(guestUrl),
            ownerStream = await slow(ownerUrl);
          assert.equal(g.active(), 2);
          await db.query(
            'DELETE FROM access_grants WHERE subject_id IN(SELECT s.id FROM access_subjects s JOIN workspace_members m ON m.id=s.member_id WHERE m.user_id=$1)',
            [guest.user],
          );
          await drained(1);
          assert.equal((await fetch(guestUrl)).status, 404);
          guestStream.destroy();
          ownerStream.destroy();
          await drained(0);
        },
      );
      await t.test(
        'workspace strong-auth policy denies control and previously issued ticket',
        async () => {
          const old = await ticket(raster);
          assert(old);
          await db.query(
            'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())',
            [workspace],
          );
          try {
            assert.equal(await ticket(raster), undefined);
            assert.equal((await fetch(old)).status, 404);
            for (const op of ['archive', 'restore'])
              assert.equal(
                (await h.call(owner, { pageId: page, version: 3 }, `${fileBase}/${raster}/${op}`))
                  .status,
                404,
              );
          } finally {
            await db.query('DELETE FROM workspace_policies WHERE workspace_id=$1', [workspace]);
          }
        },
      );
      await t.test(
        'logout and database control loss fail closed for existing and new reads',
        async () => {
          const url = await ticket(large);
          assert(url);
          const stream = await slow(url);
          await db.query(
            "UPDATE auth_sessions SET expires_at=clock_timestamp()-interval '1 second' WHERE id=$1",
            [owner.session],
          );
          await drained(0);
          stream.destroy();
          assert.equal((await fetch(url)).status, 404);
          await db.query(
            "UPDATE auth_sessions SET expires_at=clock_timestamp()+interval '1 hour' WHERE id=$1",
            [owner.session],
          );
          const fresh = await ticket(large);
          assert(fresh);
          const last = await slow(fresh);
          await db.query(
            'SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1',
            [gatewayName],
          );
          await drained(0);
          last.destroy();
          assert.equal((await fetch(fresh)).status, 503);
        },
      );
    } finally {
      await g.close();
      server.closeAllConnections();
      await new Promise<void>((r) => server.close(() => r()));
      await connection.pool.end();
      jobs.close();
      await h.close();
      await store.close();
    }
  },
);
