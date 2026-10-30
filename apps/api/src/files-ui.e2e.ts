import { converterFixture } from '../../../scripts/file-converter-fixture.mjs';
import { guardTestDocker } from '../../../scripts/docker-test-isolation.mjs';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync, spawnSync, spawn } from 'node:child_process';
import { createServer, request } from 'node:http';
import { createServer as tcpServer } from 'node:net';
import { pipeline } from 'node:stream';
import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { chromium, expect } from '@playwright/test';
import { storageFixture } from './testing/storage-fixture.ts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import { UploadService } from '@memoria/storage/uploads';
import { FileValidator } from '@memoria/storage/validate';
import { createDatabase } from '@memoria/db';
import { fileGateway } from '../../files/src/gateway.ts';
import { initialDocument } from '@memoria/collaboration-core';
import { imageFixture } from '../../../scripts/file-image-fixture.mjs';
import { idleFront } from './testing/collaboration-idle-front.ts';

// Product UI on built Next.js, real Nest, WSS, RustFS and isolated Caddy. No mocked file routes.
const idleOnly = process.argv.includes('--idle');
await test(
  idleOnly
    ? '7d real front: one idle editor for at least five minutes'
    : '7c product UI: cells/editor, uploads, previews, warnings, guests and cache resurrection',
  { timeout: idleOnly ? 420000 : 300000 },
  async (t) => {
    const converter = await converterFixture();
    t.after(() => converter.close());

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
    const webPort = await freePort(),
      collabPort = await freePort(),
      controlPort = await freePort();
    process.env.COLLAB_INTERNAL_URL = `http://127.0.0.1:${controlPort}/internal/collaboration`;
    const filesOrigin = `https://uploads.localhost:${filesPort}`;
    process.env.FILES_ORIGIN = filesOrigin;
    const store = await storageFixture();
    process.env.S3_PUBLIC_ENDPOINT = uploads;
    const h = await databaseHttpFixture(),
      owner = await h.account('owner');
    const guest = await h.account('guest');
    const children: ReturnType<typeof spawn>[] = [];
    const start = (args: string[], extra: NodeJS.ProcessEnv = {}) => {
      const child = spawn(process.execPath, args, {
        env: { ...process.env, ...extra },
        windowsHide: true,
        stdio: ['ignore', 'pipe', 'pipe'],
      });
      children.push(child);
      child.stdout?.on('data', () => {});
      child.stderr?.on('data', () => {});
      return child;
    };
    start(
      [
        'apps/web/node_modules/next/dist/bin/next',
        'start',
        'apps/web',
        '--hostname',
        '0.0.0.0',
        '--port',
        String(webPort),
      ],
      { NODE_ENV: 'production' },
    );
    start(['apps/collab/dist/main.mjs'], {
      COLLAB_HOST: '0.0.0.0',
      COLLAB_PORT: String(collabPort),
      COLLAB_INTERNAL_PORT: String(controlPort),
    });
    const property = randomUUID(),
      row = h.f.rows[0]!,
      workspace = h.f.db.workspace,
      db = h.f.db.pool;
    await db.query(
      "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position) VALUES($1,$2,$3,'assets','Assets','files','a9')",
      [property, workspace, h.f.bases[0]],
    );
    const initial = initialDocument();
    await db.query(
      'INSERT INTO collaboration_documents(workspace_id,page_id,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5)',
      [workspace, row, initial.snapshot, initial.snapshot.length, initial.businessBytes],
    );
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
    const name = 'memoria-files-ui-' + randomUUID(),
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
    handle /api/* {
      reverse_proxy host.docker.internal:${new URL(h.origin).port}
    }
    handle /collab {
      reverse_proxy host.docker.internal:${collabPort}
    }
    handle {
      reverse_proxy host.docker.internal:${webPort}
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
      const validator = new FileValidator(jobs, converter.config);
      const href = `/workspaces/${workspace}/databases/${h.f.bases[0]}`;
      const rowHref = href + '/rows/' + row;
      if (idleOnly) {
        await idleFront(page, db, row, origin + rowHref, directory);
        return;
      }
      const source = await imageFixture();
      const errors: string[] = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const quota: number[] = [];
      context.on('response', (r) => {
        if (r.status() === 429) quota.push(r.status());
        if (r.status() >= 400 && new URL(r.url()).pathname.startsWith('/api/'))
          void r
            .json()
            .then((b) => console.info('UI HTTP', r.status(), b.code))
            .catch(() => {});
      });
      const finish = async (user = owner.user) => {
        for (let i = 0; i < 50; i++) {
          await jobs.tick();
          const pending = (
            await db.query(
              "SELECT f.id,f.state FROM files f JOIN file_upload_intents i ON i.file_id=f.id WHERE i.user_id=$1 AND f.state IN ('uploading','completing','validating')",
              [user],
            )
          ).rows;
          if (pending.some((p) => p.state === 'validating')) await validator.tick();
          if (!pending.length) return;
          await new Promise((r) => setTimeout(r, 200));
        }
        throw Error('UI_UPLOAD_NOT_READY');
      };
      const openCell = async () => {
        await page.goto(origin + href);
        await page.getByRole('button', { name: 'Modifier Assets de Row 0', exact: true }).click();
      };
      await openCell();
      await page.getByLabel('Fichier à envoyer', { exact: true }).setInputFiles({
        name: 'texture.png',
        mimeType: 'image/png',
        buffer: await readFile(resolve(source, 'exif.jpg')),
      });
      await expect(page.getByText('Envoi terminé.', { exact: false })).toBeVisible({
        timeout: 20000,
      });
      await finish();
      await page.getByRole('button', { name: 'Vérifier et joindre le fichier' }).click();
      await expect(
        page.getByText(
          'Fichier prêt. Confirmez la cellule, ou attendez l’enregistrement de la page.',
          { exact: true },
        ),
      ).toBeVisible();
      await expect(page.getByText('texture.png · À joindre à la confirmation')).toBeVisible();
      await page.getByRole('button', { name: 'Enregistrer la cellule', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Modifier Assets' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Modifier Assets de Row 0', exact: true }).click();
      await expect(page.locator('[data-file-id] img')).toBeVisible();
      await expect
        .poll(() =>
          page
            .locator('[data-file-id] img')
            .evaluate((img: HTMLImageElement) => img.naturalWidth > 0),
        )
        .toBe(true);
      // A disguised active original is downloadable only after the product warning.
      await page.getByLabel('Fichier à envoyer', { exact: true }).setInputFiles({
        name: 'disguised.png',
        mimeType: 'image/png',
        buffer: await readFile(resolve(source, 'active.svg')),
      });
      await expect(page.getByText('Envoi terminé.', { exact: false })).toBeVisible({
        timeout: 20000,
      });
      await finish();
      await page.getByRole('button', { name: 'Vérifier et joindre le fichier' }).click();
      await expect(
        page.getByText(
          'Fichier prêt. Confirmez la cellule, ou attendez l’enregistrement de la page.',
          { exact: true },
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Enregistrer la cellule', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Modifier Assets' })).toHaveCount(0);
      await page.getByRole('button', { name: 'Modifier Assets de Row 0', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Télécharger disguised.png', exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Télécharger disguised.png', exact: true }).click();
      await expect(
        page.getByRole('alertdialog', { name: 'Confirmer le téléchargement' }),
      ).toBeVisible();
      const download = page.waitForEvent('download');
      await page.getByRole('button', { name: 'Télécharger quand même' }).click();
      assert.equal((await download).suggestedFilename(), 'disguised.png');
      const guestContext = await browser.newContext();
      await guestContext.addCookies(
        guest.cookie.split('; ').map((pair) => {
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
      const guestPage = await guestContext.newPage();
      await guestPage.goto(origin + href);
      await guestPage.getByRole('button', { name: 'Consulter Assets de Row 0' }).click();
      await expect(
        guestPage.getByRole('button', { name: 'Télécharger texture.png', exact: true }),
      ).toBeEnabled();
      await expect(guestPage.getByLabel('Fichier à envoyer', { exact: true })).toHaveCount(0);
      // Final product resume: actually deliver part 1, interrupt part 2, close/reopen the UI.
      const longPath = resolve(directory, 'long-asset.bin'),
        wrongPath = resolve(directory, 'wrong', 'long-asset.bin');
      await mkdir(resolve(directory, 'wrong'), { recursive: true });
      await writeFile(longPath, Buffer.alloc(81 * 1024 ** 2, 37));
      await writeFile(wrongPath, Buffer.alloc(81 * 1024 ** 2, 38));
      await context.route(uploads + '/**', async (route) => {
        if (
          route.request().method() === 'PUT' &&
          new URL(route.request().url()).searchParams.get('partNumber') === '2'
        )
          await route.abort('internetdisconnected');
        else await route.continue();
      });
      await page.getByLabel('Fichier à envoyer', { exact: true }).setInputFiles(longPath);
      await expect(page.getByRole('button', { name: 'Mettre en pause' })).toHaveCount(0, {
        timeout: 25000,
      });
      await context.unroute(uploads + '/**');
      await openCell();
      await page.getByRole('button', { name: 'Reprendre un envoi', exact: true }).click();
      await page
        .getByLabel('Envoi à reprendre', { exact: true })
        .selectOption({ label: 'long-asset.bin' });
      await page.getByLabel('Fichier à envoyer', { exact: true }).setInputFiles(wrongPath);
      await expect(
        page.getByText('Ce fichier ne correspond pas à celui commencé.', { exact: false }),
      ).toBeVisible({ timeout: 20000 });
      await page.getByLabel('Fichier à envoyer', { exact: true }).setInputFiles(longPath);
      await expect(page.getByText('Envoi terminé.', { exact: false })).toBeVisible({
        timeout: 30000,
      });
      await finish();
      await page.getByRole('button', { name: 'Vérifier et joindre le fichier' }).click();
      await expect(
        page.getByText(
          'Fichier prêt. Confirmez la cellule, ou attendez l’enregistrement de la page.',
          { exact: true },
        ),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Enregistrer la cellule', exact: true }).click();
      await expect(page.getByRole('dialog', { name: 'Modifier Assets' })).toHaveCount(0);
      await db.query(
        "UPDATE access_grants SET level='edit' WHERE subject_id IN(SELECT id FROM access_subjects WHERE member_id IN(SELECT id FROM workspace_members WHERE user_id=$1 AND workspace_id=$2))",
        [guest.user, workspace],
      );
      await guestPage.reload();
      await guestPage.getByRole('button', { name: 'Modifier Assets de Row 0' }).click();
      await guestPage.getByLabel('Fichier à envoyer', { exact: true }).setInputFiles({
        name: 'guest-task.txt',
        mimeType: 'text/plain',
        buffer: Buffer.from('guest task asset'),
      });
      await expect(guestPage.getByText('Envoi terminé.', { exact: false })).toBeVisible({
        timeout: 20000,
      });
      await finish(guest.user);
      await guestPage.getByRole('button', { name: 'Vérifier et joindre le fichier' }).click();
      await expect(
        guestPage.getByText(
          'Fichier prêt. Confirmez la cellule, ou attendez l’enregistrement de la page.',
          { exact: true },
        ),
      ).toBeVisible();
      await guestPage.getByRole('button', { name: 'Enregistrer la cellule', exact: true }).click();
      await expect(guestPage.getByRole('dialog', { name: 'Modifier Assets' })).toHaveCount(0);
      await expect(guestPage.getByRole('button', { name: 'Gérer les colonnes' })).toHaveCount(0);
      // Editor uses the same live file component; the reference enters the real Yjs journal.
      await page.goto(origin + rowHref);
      await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
        timeout: 30000,
      });
      await page.getByRole('button', { name: 'Ajouter un fichier', exact: true }).click();
      await page.getByText('Réutiliser un fichier d’une page', { exact: true }).click();
      await page.getByLabel('Lien de la page source').fill(origin + rowHref);
      await page.getByRole('button', { name: 'Afficher les fichiers accessibles' }).click();
      await page.getByRole('button', { name: 'Réutiliser texture.png', exact: true }).click();
      await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
        timeout: 10000,
      });
      await expect
        .poll(async () =>
          Number(
            (
              await db.query(
                "SELECT count(*) n FROM file_usages WHERE page_id=$1 AND slot_kind='block'",
                [row],
              )
            ).rows[0].n,
          ),
        )
        .toBe(1);
      await guestPage.goto(origin + rowHref);
      await expect(
        guestPage.getByRole('button', { name: 'Télécharger texture.png', exact: true }),
      ).toBeEnabled({ timeout: 15000 });
      // Real offline tab: revocation happens while it holds a decoded preview. Wake must purge it.
      await guestContext.setOffline(true);
      const frozen = await guestContext.newCDPSession(guestPage);
      await frozen.send('Page.setWebLifecycleState', { state: 'frozen' });
      await db.query(
        'DELETE FROM access_grants WHERE subject_id IN (SELECT id FROM access_subjects WHERE member_id IN (SELECT id FROM workspace_members WHERE user_id=$1 AND workspace_id=$2))',
        [guest.user, workspace],
      );
      await guestContext.setOffline(false);
      await frozen.send('Page.setWebLifecycleState', { state: 'active' });
      await expect(
        guestPage.getByRole('button', { name: 'Télécharger texture.png', exact: true }),
      ).toHaveCount(0, { timeout: 10000 });
      await guestPage.reload();
      await expect(guestPage.locator('[data-file-id] img')).toHaveCount(0);
      // No file bytes/URL/name manifest in persistent stores. Existing Yjs persists IDs only.
      const persistence = await page.evaluate(async () => {
        const keys = await caches.keys();
        const databases = await indexedDB.databases();
        return {
          keys,
          names: databases.map((d) => d.name),
          local: Object.keys(localStorage).map((k) => localStorage.getItem(k)),
        };
      });
      assert.deepEqual(persistence.keys, []);
      assert(!JSON.stringify(persistence).includes('texture.png'));
      assert(!JSON.stringify(persistence).includes('/v1/files/'));
      assert(observations.length > 0);
      assert(observations.every((o) => !o.cookie));
      assert(readCookies.every((c) => !c));
      await page.screenshot({ path: resolve(directory, 'editor.png'), fullPage: true });
      await db.query(
        'INSERT INTO workspace_policies(workspace_id,allow_persistent_cache) VALUES($1,false)',
        [workspace],
      );
      await expect(page.getByTestId('local-save-status')).toContainText('désactivée', {
        timeout: 10000,
      });
      await page.reload();
      await expect(
        page.getByRole('button', { name: 'Télécharger texture.png', exact: true }),
      ).toBeEnabled({ timeout: 15000 });
      const cached = await page.evaluate(
        () =>
          new Promise<number>((resolve, reject) => {
            const r = indexedDB.open('memoria-yjs-cache-v1');
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const db = r.result,
                tx = db.transaction(['documents', 'updates']),
                docs = tx.objectStore('documents').count(),
                updates = tx.objectStore('updates').count();
              tx.oncomplete = () => {
                db.close();
                resolve(docs.result + updates.result);
              };
            };
          }),
      );
      assert.equal(cached, 0);
      // A successful metadata response is delayed across real logout in a second tab.
      let held = false,
        release: () => void = () => {};
      const waiting = new Promise<void>((r) => {
        release = r;
      });
      await context.route('**/files/resolve', async (route) => {
        const response = await route.fetch();
        held = true;
        await waiting;
        await route.fulfill({ response }).catch(() => {});
      });
      await expect.poll(() => held, { timeout: 8000 }).toBe(true);
      const logout = await context.newPage();
      await logout.goto(origin + '/');
      await logout.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await logout
        .getByRole('button', { name: 'Effacer les copies locales et se déconnecter', exact: true })
        .click();
      await expect(page.locator('[data-file-id]')).toHaveCount(0, { timeout: 10000 });
      release();
      await context.unroute('**/files/resolve');
      await page.reload();
      await expect(page.locator('[data-file-id]')).toHaveCount(0);
      assert.deepEqual(errors, []);
      assert.deepEqual(quota, []);
      await writeFile(
        resolve(directory, 'report.json'),
        JSON.stringify(
          {
            date: new Date().toISOString(),
            tests: [
              'cell-upload-real-decoder',
              'preview-no-original',
              'disguised-active-warning',
              'guest-read-download',
              'multipart-81MiB-six-parts-reopen-resume',
              'mismatched-file-refused',
              'guest-edit-task-attachment-no-schema',
              'editor-Yjs-file-ledger',
              'offline-frozen-tab-revocation-wake',
              'no-persistent-file-payload',
              'workspace-cache-ban-no-Yjs-data-after-reload',
              'other-tab-logout-delayed-response-no-resurrection',
              'no-cookie-upload-read',
              'no-429',
            ],
            scope:
              'Final product on built Next, real Nest/PostgreSQL/RustFS/WSS/HTTPS; isolated proxy and storage.',
          },
          null,
          2,
        ),
      );
      console.info('PASS 7c product UI; report ' + directory + '/report.json');
    } finally {
      await browser.close();
      for (const child of children) {
        child.kill();
        await new Promise<void>((r) => {
          if (child.exitCode !== null || child.signalCode) r();
          else child.once('exit', () => r());
        });
      }
      if (started) docker(['rm', '--force', name]);
      jobs.close();
      await reading.close();
      readServer.closeAllConnections();
      await new Promise<void>((r) => readServer.close(() => r()));
      await readDb.pool.end();
      proxy.closeAllConnections();
      await new Promise<void>((r) => proxy.close(() => r()));
      await h.close();
      await store.close();
    }
  },
);
