import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { promisify } from 'node:util';
import { execFile } from 'node:child_process';
import { readFile, readdir, mkdir, writeFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { Readable } from 'node:stream';
import { request } from 'node:http';
import { createDatabase, FileReading } from '@memoria/db';
import { ReadTickets } from '@memoria/storage/read-ticket';
import { guardTestDocker } from '../../../scripts/docker-test-isolation.mjs';
import { storageFixture } from '../../api/src/testing/storage-fixture.ts';
import { fileGateway } from './gateway.ts';
const exec = promisify(execFile);
test(
  '7d gateway reconnects after real LISTEN loss and PostgreSQL restart, without reviving flows',
  { timeout: 120000 },
  async () => {
    const name = 'memoria-gateway-recovery-' + randomUUID();
    const password = randomBytes(32).toString('hex');
    const docker = async (args: string[]) =>
      (
        await exec('docker', guardTestDocker(args), {
          windowsHide: true,
          timeout: 30000,
          env: { ...process.env, POSTGRES_PASSWORD: password },
        })
      ).stdout.trim();
    await docker([
      'run',
      '-d',
      '--name',
      name,
      '--publish',
      '127.0.0.1::5432',
      '--env',
      'POSTGRES_PASSWORD',
      '--memory',
      '512m',
      'postgres:17-alpine',
    ]);
    const port = (await docker(['port', name, '5432/tcp'])).split(':').at(-1);
    const url = `postgres://postgres:${password}@127.0.0.1:${port}/postgres`;
    const admin = createDatabase(url, { timeout: 1000 }),
      store = await storageFixture();
    let gateway: Awaited<ReturnType<typeof fileGateway>> | undefined;
    let server: ReturnType<Awaited<ReturnType<typeof fileGateway>>['app']['listen']> | undefined;
    let control: ReturnType<typeof createDatabase> | undefined;
    const until = async (fn: () => Promise<boolean>, ms = 15000) => {
      const start = performance.now();
      while (performance.now() - start < ms) {
        if (await fn().catch(() => false)) return performance.now() - start;
        await delay(30);
      }
      throw Error('GATEWAY_RECOVERY_TIMEOUT');
    };
    try {
      await until(async () => (await admin.pool.query('SELECT 1')).rowCount === 1);
      for (const file of (await readdir('packages/db/drizzle'))
        .filter((n) => n.endsWith('.sql'))
        .sort())
        await admin.pool.query(
          (await readFile('packages/db/drizzle/' + file, 'utf8')).replaceAll(
            '--> statement-breakpoint',
            '',
          ),
        );
      const user = randomUUID(),
        session = randomUUID(),
        w = randomUUID(),
        page = randomUUID(),
        gen = randomUUID(),
        file = randomUUID();
      await admin.pool.query(
        "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Recovery test',$2,true)",
        [user, user + '@example.test'],
      );
      await admin.pool.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Recovery',$2)", [
        w,
        w,
      ]);
      await admin.pool.query(
        "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
        [w, user],
      );
      await admin.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        w,
        user,
      ]);
      await admin.pool.query(
        "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
        [session, user, randomUUID()],
      );
      await admin.pool.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'a0')", [
        page,
        w,
      ]);
      await admin.pool.query(
        'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,2,2)',
        [page, w, gen, Buffer.from([0, 0])],
      );
      await admin.pool.query(
        'INSERT INTO file_ledger_states(page_id,generation,revision) VALUES($1,$2,0)',
        [page, gen],
      );
      const bytes = Buffer.alloc(16 * 1024 ** 2, 31),
        key = 'objects/' + file;
      await store.storage.restoreObject(
        key,
        Readable.from([bytes]),
        bytes.length,
        createHash('sha256').update(bytes).digest('base64'),
      );
      await admin.pool.query(
        "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$3,'fixture.bin','application/octet-stream',$4,'ready')",
        [file, w, key, bytes.length],
      );
      await admin.pool.query(
        "INSERT INTO file_usages(workspace_id,file_id,page_id,slot_kind,slot_id,generation,revision) VALUES($1,$2,$3,'block',$4,$5,0)",
        [w, file, page, randomUUID(), gen],
      );
      const controlName = 'gateway-' + randomUUID();
      const controlUrl = new URL(url);
      controlUrl.searchParams.set('application_name', controlName);
      control = createDatabase(controlUrl.toString(), { timeout: 1000 });
      const secret = randomBytes(32).toString('hex');
      gateway = await fileGateway({
        ...control,
        storage: store.storage,
        secret,
        origin: 'https://localhost',
        trustedProxy: [],
      });
      server = gateway.app.listen(0, '127.0.0.1');
      await new Promise<void>((r) => server!.once('listening', r));
      const address = server.address();
      assert(address && typeof address !== 'string');
      const origin = 'http://127.0.0.1:' + address.port;
      const claim = await new FileReading(admin.pool).issue(
        { key: 'test', user, session, workspace: w, page },
        file,
        'original',
      );
      const path = origin + '/v1/files/' + new ReadTickets(secret).issue(claim);
      const health = async () => (await fetch(origin + '/health')).status;
      const open = async () =>
        new Promise<import('node:http').IncomingMessage>((resolve, reject) => {
          request(path, (r) => {
            r.pause();
            r.on('error', () => {});
            resolve(r);
          })
            .on('error', reject)
            .end();
        });
      const first = await open();
      assert.equal(first.statusCode, 200);
      await admin.pool.query(
        "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%LISTEN memoria_collaboration%'",
        [controlName],
      );
      await until(async () => gateway!.active() === 0, 5000);
      first.destroy();
      const listenMs = await until(async () => (await health()) === 200);
      assert.equal((await fetch(path, { method: 'HEAD' })).status, 200);

      // Hold an admission after SQL authorization, then reconnect before allowing it to publish.
      const authorize = FileReading.prototype.authorize;
      let release!: () => void, entered!: () => void;
      const held = new Promise<void>((r) => (release = r)),
        waiting = new Promise<void>((r) => (entered = r));
      FileReading.prototype.authorize = async function (c) {
        const value = await authorize.call(this, c);
        entered();
        await held;
        return value;
      };
      try {
        const pending = fetch(path, { method: 'HEAD' });
        await waiting;
        await admin.pool.query(
          "SELECT pg_terminate_backend(pid) FROM pg_stat_activity WHERE application_name=$1 AND query LIKE '%LISTEN memoria_collaboration%'",
          [controlName],
        );
        await delay(500);
        await until(async () => (await health()) === 200);
        release();
        assert.equal((await pending).status, 503);
      } finally {
        release();
        FileReading.prototype.authorize = authorize;
      }

      const second = await open();
      assert.equal(second.statusCode, 200);
      await docker(['stop', '--time', '0', name]);
      await until(async () => gateway!.active() === 0, 5000);
      second.destroy();
      assert.equal(await health(), 503);
      assert.equal((await fetch(path, { method: 'HEAD' })).status, 503);
      await delay(500);
      assert.equal(await health(), 503);
      await docker(['start', name]);
      const postgresMs = await until(async () => (await health()) === 200);
      assert.equal((await fetch(path, { method: 'HEAD' })).status, 200);
      await admin.pool.query(
        "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
        [session],
      );
      assert.equal((await fetch(path, { method: 'HEAD' })).status, 404);
      await mkdir('.local/7d', { recursive: true });
      await writeFile(
        '.local/7d/gateway-recovery.json',
        JSON.stringify(
          {
            date: new Date().toISOString(),
            listenRecoveryMs: listenMs,
            postgresRecoveryAfterStartMs: postgresMs,
            oldFlowsClosed: true,
            pendingAdmissionRefused: true,
            revokedSessionRefused: true,
            scope: 'Functional recovery timing, not a capacity benchmark',
          },
          null,
          2,
        ),
      );
    } finally {
      await gateway?.close();
      server?.closeAllConnections();
      if (server) await new Promise<void>((r) => server!.close(() => r()));
      await control?.pool.end();
      await admin.pool.end();
      await store.close();
      await docker(['rm', '--force', '--volumes', name]);
    }
  },
);
