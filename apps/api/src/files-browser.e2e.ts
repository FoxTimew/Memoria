import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { pipeline } from 'node:stream';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium } from '@playwright/test';
import { storageFixture } from './testing/storage-fixture.ts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { UploadService } from '@memoria/storage/uploads';

// Protocol harness, not the future 7c product UI. Real browser fetch, cookies, TLS/CORS,
// real Nest session guard and private disposable PostgreSQL/RustFS behind Caddy.
await test(
  '7a browser HTTPS POST/multipart/resume, origin and cookie boundaries',
  { timeout: 180000 },
  async () => {
    const docker = (args: string[]) =>
      execFileSync('docker', args, { encoding: 'utf8', windowsHide: true, timeout: 30000 }).trim();
    const current = docker(['compose', 'ps', '-q', 'caddy']);
    if (!/^[0-9a-f]{12,64}$/.test(current)) throw Error('Start local Caddy first');
    const image = docker(['inspect', '--format', '{{.Image}}', current]);
    const certificateVolume = docker([
      'inspect',
      '--format',
      '{{range .Mounts}}{{if eq .Destination "/data"}}{{.Name}}{{end}}{{end}}',
      current,
    ]);
    if (!/^[a-zA-Z0-9_-]+$/.test(certificateVolume))
      throw Error('Expected a named Caddy TLS volume');
    const freePort = async () => {
      const s = tcpServer();
      await new Promise<void>((r) => s.listen(0, '127.0.0.1', r));
      const p = (s.address() as { port: number }).port;
      await new Promise<void>((r, j) => s.close((e) => (e ? j(e) : r())));
      return p;
    };
    const appPort = await freePort(),
      uploadPort = await freePort();
    const origin = `https://localhost:${appPort}`,
      uploads = `https://uploads.localhost:${uploadPort}`;
    process.env.APP_ORIGIN = origin;
    const store = await storageFixture();
    process.env.S3_PUBLIC_ENDPOINT = uploads;
    const h = await databaseHttpFixture(),
      owner = await h.account('owner');
    const jobs = new UploadService(h.f.db.pool, { ...store.config, publicEndpoint: uploads });
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
    tls /trusted/caddy/certificates/local/localhost/localhost.crt /trusted/caddy/certificates/local/localhost/localhost.key
    handle /fixture {
      header Content-Type text/html
      respond "<!doctype html><title>Memoria transport fixture</title><h1>Fixture de transport 7a</h1>" 200
    }
    handle {
      reverse_proxy host.docker.internal:${new URL(h.origin).port}
    }
  }
  https://uploads.localhost:8444 {
    tls /trusted/caddy/certificates/local/uploads.localhost/uploads.localhost.crt /trusted/caddy/certificates/local/uploads.localhost/uploads.localhost.key
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
  `;
    await writeFile(resolve(directory, 'Caddyfile'), config);
    let started = false;
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    try {
      // Read only the existing trusted leaf certificates. Separate anonymous /data and
      // /config volumes; no shared autosave, CA write, exported key or TLS bypass.
      docker([
        'run',
        '--pull=never',
        '--rm',
        '-d',
        '--name',
        name,
        '--mount',
        `type=volume,src=${certificateVolume},dst=/trusted,readonly`,
        '--mount',
        `type=bind,src=${resolve(directory, 'Caddyfile')},dst=/fixture/Caddyfile,readonly`,
        '--publish',
        `127.0.0.1:${appPort}:8443`,
        '--publish',
        `127.0.0.1:${uploadPort}:8444`,
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
      await new Promise<void>((r) => proxy.close(() => r()));
      await h.close();
      await store.close();
    }
  },
);
