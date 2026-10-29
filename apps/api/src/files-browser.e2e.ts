import { guardTestDocker } from '../../../scripts/docker-test-isolation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { pipeline } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { storageFixture } from './testing/storage-fixture.ts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { UploadService } from '@memoria/storage/uploads';
import { FileValidator } from '@memoria/storage/validate';
import { FileCells, createDatabase } from '@memoria/db';
import { fileGateway } from '../../files/src/gateway.ts';
import { imageId } from '../../../scripts/file-image-fixture.mjs';

// Protocol harness, not the future 7c product UI. Real browser fetch, cookies, TLS/CORS,
// real Nest session guard and private disposable PostgreSQL/RustFS behind Caddy.
await test(
  '7a browser HTTPS POST/multipart/resume, origin and cookie boundaries',
  { timeout: 180000 },
  async () => {
    const docker = (args: string[]) => {
      const result = spawnSync('docker', guardTestDocker(args), {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
        stdio: 'pipe',
      });
      if (result.status !== 0) throw Error('BROWSER_DOCKER_FIXTURE_FAILED');
      return (args[0] === 'logs' ? result.stdout + result.stderr : result.stdout).trim();
    };
    const current = docker(['compose', 'ps', '-q', 'caddy']);
    if (!/^[0-9a-f]{12,64}$/.test(current)) throw Error('Start local Caddy first');
    const image = docker(['inspect', '--format', '{{.Image}}', current]);
    const freePort = async () => {
      const s = tcpServer();
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      const p = (s.address() as { port: number }).port;
      await new Promise<void>((r, j) => s.close((e) => (e ? j(e) : r())));
      return p;
    };
    const appPort = await freePort(),
      uploadPort = await freePort(),
      filesPort = await freePort();
    const origin = `https://localhost:${appPort}`,
      uploads = `https://uploads.localhost:${uploadPort}`;
    process.env.APP_ORIGIN = origin;
    const filesOrigin = `https://uploads.localhost:${filesPort}`;
    process.env.FILES_ORIGIN = filesOrigin;
    const store = await storageFixture();
    process.env.S3_PUBLIC_ENDPOINT = uploads;
    const h = await databaseHttpFixture(),
      owner = await h.account('owner');
    const jobs = new UploadService(h.f.db.pool, { ...store.config, publicEndpoint: uploads });
    const readDb = createDatabase(h.f.db.url, { max: 6, timeout: 1500 });
    const reading = await fileGateway({
      ...readDb,
      storage: store.storage,
      secret: h.config.BETTER_AUTH_SECRET,
      origin,
      trustedProxy: ['loopback', '172.16.0.0/12'],
    });
    const readCookies: boolean[] = [];
    const readServer = createServer((req, res) => {
      readCookies.push(!!req.headers.cookie);
      reading.app(req, res);
    });
    await new Promise<void>((r) => readServer.listen(0, '0.0.0.0', r));
    const readPort = (readServer.address() as { port: number }).port;
    const name = 'memoria-files-browser-' + randomUUID(),
      directory = resolve('.local/files-browser', name);
    const observations: { method: string; cookie: boolean; origin: string | undefined }[] = [];
    const proxy = createServer((req, res) => {
      observations.push({
        method: req.method!,
        cookie: !!req.headers.cookie,
        origin: req.headers.origin,
      });
      const upstream = request(
        new URL(req.url!, store.config.endpoint),
        { method: req.method, headers: req.headers },
        (response) => {
          res.writeHead(response.statusCode!, response.headers);
          pipeline(response, res, () => {});
        },
      );
      upstream.on('error', () => {
        if (!res.headersSent) res.writeHead(502);
        res.end();
      });
      pipeline(req, upstream, () => {});
    });
    await new Promise<void>((r) => proxy.listen(0, '0.0.0.0', r));
    const proxyPort = (proxy.address() as { port: number }).port;
    await mkdir(directory, { recursive: true });
    const config = `{
    log default {
      format filter {
        request>uri delete
        request>headers delete
        resp_headers delete
      }
    }
    admin off
    auto_https disable_redirects
    servers :8444 {
      timeouts {
        read_header 10s
        read_body 120s
      }
    }
  }
  https://localhost:8443 {
    tls /etc/localhost/localhost.crt /etc/localhost/localhost.key
    handle /fixture {
      header Content-Type text/html
      respond "<!doctype html><title>Memoria transport fixture</title><h1>Fixture de transport 7a</h1>" 200
    }
    handle {
      reverse_proxy host.docker.internal:${new URL(h.origin).port}
    }
  }
  https://uploads.localhost:8444 {
    tls /etc/uploads.localhost/uploads.localhost.crt /etc/uploads.localhost/uploads.localhost.key
    @upload method POST PUT OPTIONS
    handle @upload {
      request_body {
        max_size 33619968
      }
      reverse_proxy host.docker.internal:${proxyPort}
    }
    handle {
      respond 403
    }
  }
  https://uploads.localhost:8445 {
    tls /etc/uploads.localhost/uploads.localhost.crt /etc/uploads.localhost/uploads.localhost.key
    reverse_proxy host.docker.internal:${readPort}
  }
  `;
    await writeFile(resolve(directory, 'Caddyfile'), config);
    let started = false;
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    try {
      // Copy exactly four leaf files, never mount development volumes or copy the CA key.
      docker([
        'create',
        '--pull=never',
        '--rm',
        '--name',
        name,
        '--mount',
        `type=bind,src=${resolve(directory, 'Caddyfile')},dst=/fixture/Caddyfile,readonly`,
        '--publish',
        `127.0.0.1:${appPort}:8443`,
        '--publish',
        `127.0.0.1:${uploadPort}:8444`,
        '--publish',
        `127.0.0.1:${filesPort}:8445`,
        '--add-host',
        'host.docker.internal:host-gateway',
        image,
        'caddy',
        'run',
        '--config',
        '/fixture/Caddyfile',
        '--adapter',
        'caddyfile',
      ]);
      started = true;
      const leaves = execFileSync(
        'docker',
        [
          'exec',
          current,
          'tar',
          '-C',
          '/data/caddy/certificates/local',
          '-cf',
          '-',
          'localhost/localhost.crt',
          'localhost/localhost.key',
          'uploads.localhost/uploads.localhost.crt',
          'uploads.localhost/uploads.localhost.key',
        ],
        { windowsHide: true, maxBuffer: 1024 * 1024 },
      );
      execFileSync('docker', ['cp', '-', name + ':/etc/'], { input: leaves, windowsHide: true });
      docker(['start', name]);
      const context = await browser.newContext();
      await context.addCookies(
        owner.cookie.split('; ').map((pair) => {
          const i = pair.indexOf('=');
          return {
            name: pair.slice(0, i),
            value: pair.slice(i + 1),
            url: origin,
            httpOnly: true,
            secure: true,
            sameSite: 'Lax' as const,
          };
        }),
      );
      const page = await context.newPage();
      for (let attempt = 0; ; attempt++) {
        try {
          await page.goto(origin + '/fixture');
          break;
        } catch (error) {
          if (attempt >= 20 || !/ERR_CONNECTION_(REFUSED|CLOSED|RESET)/.test(String(error)))
            throw error;
          await new Promise((r) => setTimeout(r, 250));
        }
      }
      const base = `/api/internal/workspaces/${h.f.db.workspace}/file-uploads`;
      async function prepare(size: number) {
        return page.evaluate(
          async ({ base, pageId, size }) => {
            const data = new Uint8Array(size).fill(27);
            const hash = async (bytes: Uint8Array) =>
              btoa(
                String.fromCharCode(
                  ...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(bytes))),
                ),
              );
            const checksum = await hash(data),
              idem = crypto.randomUUID();
            const response = await fetch(base, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                pageId,
                bytes: size,
                name: 'browser asset',
                checksum,
                idempotency: idem,
              }),
            });
            const state = await response.json();
            if (response.status !== 201)
              throw Error('initiate ' + response.status + ' ' + state.code);
            const parts =
              state.mode === 'post'
                ? [data]
                : Array.from({ length: Math.ceil(size / state.partBytes) }, (_, i) =>
                    data.slice(i * state.partBytes, (i + 1) * state.partBytes),
                  );
            const plan = await Promise.all(
              parts.map(async (p, i) => ({
                number: i + 1,
                bytes: p.length,
                checksum: await hash(p),
              })),
            );
            const signed = await fetch(base + '/' + state.id + '/parts', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ request: crypto.randomUUID(), parts: plan }),
            });
            if (signed.status !== 200) throw Error('sign ' + signed.status);
            return { id: String(state.id), signed: await signed.json(), mode: state.mode };
          },
          { base, pageId: h.f.rows[0]!, size },
        );
      }
      type Signature = {
        post?: { url: string; fields: Record<string, string> };
        url?: string;
        headers?: Record<string, string>;
      };
      async function send(signature: Signature, size: number) {
        return page.evaluate(
          async ({ signature, size }) => {
            const data = new Uint8Array(size).fill(27);
            let response: Response;
            if (signature.post) {
              const form = new FormData();
              for (const [k, v] of Object.entries(signature.post.fields)) form.append(k, v);
              form.append('file', new Blob([data]), 'asset');
              response = await fetch(signature.post.url, {
                method: 'POST',
                body: form,
                credentials: 'omit',
              });
            } else
              response = await fetch(signature.url!, {
                method: 'PUT',
                headers: signature.headers ?? {},
                body: data,
                credentials: 'omit',
              });
            return { status: response.status, etag: response.headers.get('etag') };
          },
          { signature, size },
        );
      }
      const post = await prepare(1024);
      const postResult = await send(post.signed.signatures[0], 1024);
      assert([200, 204].includes(postResult.status));
      const postCount = observations.filter((x) => x.method === 'POST').length;
      // A simple POST is sent before CORS response checks. Deliberately include credentials
      // once to observe the actual wire boundary, not Playwright's approximate cookie filter.
      await page.evaluate(async (signature: Signature) => {
        const form = new FormData();
        for (const [k, v] of Object.entries(signature.post!.fields)) form.append(k, v);
        form.append('file', new Blob([new Uint8Array(1024).fill(27)]), 'asset');
        try {
          await fetch(signature.post!.url, { method: 'POST', body: form, credentials: 'include' });
        } catch {
          /* RustFS need not allow credentialed response access. */
        }
      }, post.signed.signatures[0]);
      assert.equal(observations.filter((x) => x.method === 'POST').length, postCount + 1);
      const complete = async (id: string) =>
        page.evaluate(
          async ({ base, id }) => {
            const r = await fetch(base + '/' + id + '/complete', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: '{}',
            });
            return r.status;
          },
          { base, id },
        );
      assert.equal(await complete(post.id), 202);
      await jobs.tick();
      assert.equal(
        (await h.f.db.pool.query('SELECT state FROM files WHERE id=$1', [post.id])).rows[0].state,
        'validating',
      );
      const multi = await prepare(33 * 1024 ** 2);
      assert.equal(multi.mode, 'multipart');
      const first = await send(multi.signed.signatures[0], 16 * 1024 ** 2);
      assert.equal(first.status, 200);
      assert(first.etag);
      await context.setOffline(true);
      await assert.rejects(send(multi.signed.signatures[1], 16 * 1024 ** 2));
      await context.setOffline(false);
      await page.reload();
      const resumed = await page.evaluate(
        async ({ base, id }) => {
          const r = await fetch(base + '/' + id + '/resume', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: '{}',
          });
          return { status: r.status, data: await r.json() };
        },
        { base, id: multi.id },
      );
      assert.equal(resumed.status, 200);
      assert.deepEqual(
        resumed.data.parts.map((p: { number: number }) => p.number),
        [1],
      );
      assert.equal((await send(multi.signed.signatures[1], 16 * 1024 ** 2)).status, 200);
      assert.equal((await send(multi.signed.signatures[2], 1024 ** 2)).status, 200);
      assert.equal(await complete(multi.id), 202);
      await jobs.tick();
      const done = (
        await h.f.db.pool.query(
          'SELECT f.state,i.bytes_verified_at,i.final_key FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE f.id=$1',
          [multi.id],
        )
      ).rows[0];
      assert.equal(done.state, 'validating');
      assert(done.bytes_verified_at);
      // Upload capabilities never need session cookies; the browser jar is host-only too.
      assert(observations.some((x) => x.method === 'POST'));
      assert(observations.some((x) => x.method === 'OPTIONS'));
      assert(observations.some((x) => x.method === 'PUT'));
      assert(observations.every((x) => !x.cookie));
      assert.equal(
        await page.evaluate(
          async (base) =>
            (
              await fetch(base, {
                method: 'POST',
                credentials: 'omit',
                headers: { 'Content-Type': 'application/json' },
                body: '{}',
              })
            ).status,
          base,
        ),
        401,
      );
      // An untrusted origin cannot use the signed PUT through a browser preflight.
      const evil = await context.newPage();
      await evil.goto(h.origin + '/api/health');
      const putCount = observations.filter((x) => x.method === 'PUT').length;
      const blocked = await evil.evaluate(async (sig: Signature) => {
        try {
          await fetch(sig.url!, {
            method: 'PUT',
            headers: sig.headers ?? {},
            body: new Uint8Array(1024 ** 2).fill(27),
          });
          return false;
        } catch {
          return true;
        }
      }, multi.signed.signatures[2]);
      assert(blocked);
      assert.equal(observations.filter((x) => x.method === 'PUT').length, putCount);
      // Read and listing are not exposed by the upload proxy, even for the application's session.
      assert.equal(
        (await context.request.get(uploads + '/fixture/' + done.final_key)).status(),
        403,
      );
      assert.equal((await context.request.get(uploads + '/fixture?list-type=2')).status(), 403);
      // 7b: a dedicated HTTPS origin, no application cookie, real authorization and download headers.
      const validator = new FileValidator(jobs, {
        image: imageId(),
        directory: resolve(directory, 'validation'),
        guard: guardTestDocker,
      });
      await validator.tick();
      await validator.tick();
      const property = randomUUID(),
        db = h.f.db.pool;
      await db.query(
        "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position) VALUES($1,$2,$3,'assets','Assets','files','a8')",
        [property, h.f.db.workspace, h.f.bases[0]],
      );
      const schema = (
        await db.query('SELECT schema_version FROM databases WHERE id=$1', [h.f.bases[0]])
      ).rows[0].schema_version;
      await new FileCells(db).write(
        {
          ...owner,
          key: 'browser-file',
          page: h.f.rows[0]!,
          rowScope: { database: h.f.bases[0]! },
        },
        property,
        String(schema),
        '0',
        { add: [post.id], remove: [] },
      );
      const readUrl = await page.evaluate(
        async ({ workspace, pageId, file }) => {
          const r = await fetch(`/api/internal/workspaces/${workspace}/files/read-tickets`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ pageId, files: [{ id: file, variant: 'original' }] }),
          });
          if (r.status !== 200) throw Error('ticket failed');
          return (await r.json()).items[0].url as string;
        },
        { workspace: h.f.db.workspace, pageId: h.f.rows[0]!, file: post.id },
      );
      const readResult = await page.evaluate(async (url) => {
        const r = await fetch(url, { credentials: 'omit', headers: { Range: 'bytes=1-3' } });
        return {
          status: r.status,
          bytes: [...new Uint8Array(await r.arrayBuffer())],
          type: r.headers.get('content-type'),
          disposition: r.headers.get('content-disposition'),
          cache: r.headers.get('cache-control'),
        };
      }, readUrl);
      assert.equal(readResult.status, 206);
      assert.deepEqual(readResult.bytes, [27, 27, 27]);
      assert.equal(readResult.type, 'application/octet-stream');
      assert.match(readResult.disposition!, /^attachment/);
      assert.match(readResult.cache!, /no-store/);
      assert(
        await evil.evaluate(async (url) => {
          try {
            await fetch(url);
            return false;
          } catch {
            return true;
          }
        }, readUrl),
      );
      assert(readCookies.length > 0 && readCookies.every((c) => !c));
      await db.query('DELETE FROM file_usages WHERE file_id=$1', [post.id]);
      assert.equal(
        await page.evaluate(
          async (url) => (await fetch(url, { credentials: 'omit' })).status,
          readUrl,
        ),
        404,
      );
      // Trigger an actual reverse-proxy error; signed URL must not be serialized in its error log.
      readServer.closeAllConnections();
      await new Promise<void>((r) => readServer.close(() => r()));
      assert.equal((await context.request.get(readUrl)).status(), 502);
      const log = docker(['logs', name]);
      assert(log.includes('http.log.error') && log.includes('502'));
      assert(!log.includes(new URL(readUrl).pathname));
      assert(!log.includes('browser asset'));
      await writeFile(
        resolve(directory, 'report.json'),
        JSON.stringify(
          {
            browser: browser.version(),
            rustfs: store.image,
            caddy: image,
            postBytes: 1024,
            multipartBytes: 33 * 1024 ** 2,
            resumedParts: [1],
            allUploadsWithoutCookie: true,
            untrustedPutPreflightBlocked: true,
            readGateway: {
              dedicatedHttps: true,
              range: true,
              noCookie: true,
              untrustedCorsBlocked: true,
              revokedTicket404: true,
              proxyErrorWithoutTicket: true,
            },
            observations: observations.map((x) => ({
              method: x.method,
              cookie: x.cookie,
              trustedOrigin: x.origin === origin,
            })),
            scope:
              'Actual HTTPS browser transport harness; not 7c UI; no TLS bypass; signed capabilities not logged.',
          },
          null,
          2,
        ),
      );
      console.info(
        'PASS browser POST 1 KiB, multipart 33 MiB (16/16/1), offline reload/resume, byte verification, cookie isolation, untrusted CORS and upload-only proxy. Report: ' +
          directory +
          '/report.json',
      );
    } finally {
      await browser.close();
      if (started) {
        try {
          await writeFile(resolve(directory, 'caddy.txt'), docker(['logs', name]));
        } finally {
          docker(['rm', '--force', name]);
        }
      }
      jobs.close();
      await reading.close();
      readServer.closeAllConnections();
      await new Promise<void>((r) => readServer.close(() => r()));
      await readDb.pool.end();
      await new Promise<void>((r) => proxy.close(() => r()));
      await h.close();
      await store.close();
    }
  },
);
