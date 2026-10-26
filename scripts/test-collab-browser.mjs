import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFile, writeFile, mkdir } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import { chromium, expect } from '@playwright/test';
import { lifecycleBrowser } from './browser-lifecycle.mjs';
const origin = process.env.APP_ORIGIN;
if (
  origin !== 'https://localhost' ||
  process.env.NODE_ENV === 'production' ||
  process.env.SMTP_HOST !== '127.0.0.1'
)
  throw new Error('Browser tests require local Caddy, PostgreSQL and Mailpit.');
const fixturePath = '.local/3b-browser-accounts.json';
await mkdir('.local', { recursive: true });
let fixture;
try {
  fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
} catch (e) {
  if (e.code !== 'ENOENT') throw e;
  fixture = { accounts: [] };
}
const persist = () => writeFile(fixturePath, JSON.stringify(fixture, null, 2), { mode: 0o600 });
async function verificationLink(email) {
  for (let i = 0; i < 30; i++) {
    const result = await (
      await globalThis.fetch(
        `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
      )
    ).json();
    const entry = result.messages?.find((m) => m.To?.some((to) => to.Address === email));
    if (entry) {
      const mail = await (
        await globalThis.fetch(`http://127.0.0.1:8025/api/v1/message/${entry.ID}`)
      ).json();
      const link = mail.Text.match(/https:\/\/localhost\/api\/auth\/verify-email\?[^\s]+/)?.[0];
      assert(link);
      return link;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 200));
  }
  throw new Error('Verification email missing');
}
await test(
  'Two browsers: collaboration, presence, persistent offline recovery and fenced sign-out',
  { timeout: 120000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const contexts = [],
      pages = [],
      errors = [],
      sockets = [];
    const lifecycle = await lifecycleBrowser();
    try {
      for (let i = 0; i < 2; i++) {
        const context =
          i === 0
            ? lifecycle.context
            : await browser.newContext({ viewport: { width: 1440, height: 1080 } });
        contexts.push(context);
        let account = fixture.accounts[i];
        if (!account) {
          account = {
            email: `collab3b-${randomUUID()}@example.test`,
            password: randomBytes(24).toString('base64url'),
            name: ['Alice 3b', 'Bob 3b'][i],
          };
          fixture.accounts[i] = account;
          await persist();
          const response = await context.request.post(origin + '/api/auth/sign-up/email', {
            headers: { Origin: origin },
            data: { ...account, callbackURL: '/connexion' },
          });
          assert.equal(response.status(), 200, 'Signup failed (check the existing per-IP quota)');
          account.created = true;
          await persist();
        }
        if (!account.verified) {
          assert(account.created, 'Incomplete signup fixture; inspect it before retrying');
          const response = await context.request.get(await verificationLink(account.email));
          assert(response.ok());
          account.verified = true;
          await persist();
        }
        const page = i === 0 ? await lifecycle.page() : await context.newPage();
        pages.push(page);
        page.on('pageerror', (error) => errors.push(error.message));
        page.on('websocket', (socket) => sockets.push(socket.url()));
        if (i === 0) {
          await page.goto(origin + '/api/health');
          await page.evaluate(
            () =>
              new Promise((resolve, reject) => {
                const r = globalThis.indexedDB.open('memoria-local-drafts-v1', 1);
                r.onupgradeneeded = () => {
                  r.result.createObjectStore('drafts');
                  r.result.createObjectStore('sessions');
                };
                r.onerror = () => reject(r.error);
                r.onsuccess = () => {
                  const tx = r.result.transaction('drafts', 'readwrite');
                  tx.objectStore('drafts').put('OLD PRIVATE DRAFT', 'old-user');
                  tx.oncomplete = () => {
                    r.result.close();
                    resolve();
                  };
                };
              }),
          );
        }
        await page.goto(origin + '/connexion');
        await page.getByLabel('Adresse email').fill(account.email);
        await page.getByLabel('Mot de passe').fill(account.password);
        await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
        await expect(
          page.getByRole('heading', { name: 'Créer un espace', exact: true }),
        ).toBeVisible({ timeout: 15000 });
      }
      if (!fixture.workspace) {
        const result = await contexts[0].request.post(origin + '/api/internal/workspaces', {
          headers: { Origin: origin },
          data: { name: 'Relecture collaboration 3b', slug: 'collab3b-' + randomUUID() },
        });
        assert(result.ok());
        fixture.workspace = (await result.json()).id;
        await persist();
      }
      const member = spawnSync(
        process.execPath,
        [
          '--env-file=.env',
          'scripts/dev-collaboration.mjs',
          'add-member',
          '--workspace',
          fixture.workspace,
          '--email',
          fixture.accounts[1].email,
        ],
        { encoding: 'utf8', windowsHide: true },
      );
      assert.equal(member.status, 0, member.stderr);
      const title = 'Collaboration ' + randomUUID().slice(0, 8);
      const created = await contexts[0].request.post(
        `${origin}/api/internal/workspaces/${fixture.workspace}/pages`,
        { headers: { Origin: origin }, data: { title, parentId: null } },
      );
      assert(created.ok());
      fixture.page = (await created.json()).id;
      await persist();
      const [a, b] = pages;
      for (const page of pages) {
        await page.goto(`${origin}/workspaces/${fixture.workspace}`);
        await page
          .getByRole('navigation', { name: 'Arbre des pages' })
          .getByRole('button', { name: new RegExp(title) })
          .click();
        await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
          timeout: 15000,
        });
      }
      assert(sockets.length >= 2 && sockets.every((url) => url === 'wss://localhost/collab'));
      for (const page of pages)
        for (const account of fixture.accounts)
          await expect(page.getByRole('list', { name: 'Personnes connectées' })).toContainText(
            account.name,
          );
      const color = await a
        .getByRole('list', { name: 'Personnes connectées' })
        .getByText(fixture.accounts[0].name, { exact: true })
        .evaluate((el) => globalThis.getComputedStyle(el).color);
      console.log(
        'PASS HTTPS login, second membership, two WSS connections and durable initial load',
      );
      const editors = pages.map((p) => p.locator('.bn-editor[contenteditable="true"]'));
      await Promise.all(
        editors.map(async (editor, i) => {
          await editor.click();
          await editor.pressSequentially(i ? 'Bravo ' : 'Alpha ');
        }),
      );
      for (const page of pages) {
        await expect(page.locator('.bn-editor')).toContainText('Alpha');
        await expect(page.locator('.bn-editor')).toContainText('Bravo');
      }
      await editors[0].click();
      await editors[0].press('ArrowLeft');
      await expect(
        b.locator('.bn-collaboration-cursor__label').filter({ hasText: fixture.accounts[0].name }),
      ).toBeVisible();
      console.log('PASS verified names, stable per-user colors and visible remote cursor');
      await editors[0].press('Control+End');
      await editors[0].press('Enter');
      await editors[0].pressSequentially('/character');
      await a.getByText('Character card', { exact: true }).click();
      for (const page of pages) await expect(page.getByLabel('Character name')).toBeVisible();
      await Promise.all([
        a.getByLabel('Character name').fill('Mira'),
        b.getByLabel('Health', { exact: true }).fill('42'),
      ]);
      for (const page of pages) {
        await expect(page.getByLabel('Character name')).toHaveValue('Mira');
        await expect(page.getByLabel('Health', { exact: true })).toHaveValue('42');
      }
      console.log('PASS simultaneous text and independent character fields');
      for (const page of pages)
        await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
      await contexts[0].setOffline(true);
      await expect(a.getByTestId('save-status')).toContainText('Hors ligne', { timeout: 20000 });
      await editors[0].press('Control+Home');
      await a.keyboard.insertText('Coupure ');
      await editors[1].press('Control+Home');
      await b.keyboard.insertText('Connecté ');
      await expect(b.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
      await contexts[0].setOffline(false);
      for (const page of pages) {
        await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
          timeout: 20000,
        });
        await expect(page.locator('.bn-editor')).toContainText('Coupure');
        await expect(page.locator('.bn-editor')).toContainText('Connecté');
      }
      console.log('PASS offline typing and reconnection merge, confirmed by server receipts');
      await a.getByRole('textbox', { name: 'Titre de la page', exact: true }).fill('Titre Alice');
      await b.getByRole('textbox', { name: 'Titre de la page', exact: true }).fill('Bob ' + title);
      await b.getByRole('button', { name: 'Enregistrer le titre', exact: true }).click();
      await expect(b.getByText('Titre non enregistré', { exact: true })).toHaveCount(0);
      await a.getByRole('button', { name: 'Enregistrer le titre', exact: true }).click();
      await expect(a.getByRole('button', { name: 'Utiliser le titre serveur' })).toBeVisible();
      await a.getByRole('button', { name: 'Utiliser le titre serveur' }).click();
      await expect(a.getByRole('textbox', { name: 'Titre de la page', exact: true })).toHaveValue(
        'Bob ' + title,
      );
      await a.reload();
      await a
        .getByRole('navigation', { name: 'Arbre des pages' })
        .getByRole('button', { name: new RegExp('Bob ' + title) })
        .last()
        .click();
      await expect(a.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
      await expect(a.locator('.bn-editor')).toContainText('Coupure');
      await expect(a.getByLabel('Health', { exact: true })).toHaveValue('42');
      assert.equal(
        (await contexts[0].request.post(origin + '/internal/collaboration', { data: {} })).status(),
        404,
      );
      assert.deepEqual(errors, []);
      await a.screenshot({ path: '.local/3c-browser.png', fullPage: true });
      console.log(
        'PASS relational title conflict, page reload preserves body, private HMAC not routed; no browser errors',
      );
      const openPage = async (page) => {
        page.on('pageerror', (error) => errors.push(error.message));
        await page.goto(`${origin}/workspaces/${fixture.workspace}`);
        await page
          .getByRole('navigation', { name: 'Arbre des pages' })
          .getByRole('button', { name: new RegExp('Bob ' + title) })
          .click();
        await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
          timeout: 15000,
        });
        await expect(page.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      };
      const cache = (page) =>
        page.evaluate(
          () =>
            new Promise((resolve, reject) => {
              const r = globalThis.indexedDB.open('memoria-yjs-cache-v1');
              r.onerror = () => reject(r.error);
              r.onsuccess = () => {
                const tx = r.result.transaction(['documents', 'updates'], 'readonly');
                const documents = tx.objectStore('documents').getAll(),
                  updates = tx.objectStore('updates').count();
                tx.oncomplete = () => {
                  r.result.close();
                  resolve({ documents: documents.result, updates: updates.result });
                };
              };
            }),
        );
      await contexts[0].setOffline(true);
      await expect(a.getByTestId('save-status')).toContainText('Hors ligne');
      await a.locator('.bn-editor').press('Control+Home');
      await a.keyboard.insertText('Fermeture3c ');
      await expect(a.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      assert((await cache(a)).documents.some((p) => p.pending.length > 0));
      await expect(b.locator('.bn-editor')).not.toContainText('Fermeture3c');
      await a.close();
      await contexts[0].setOffline(false);
      const reopened = await lifecycle.page();
      await openPage(reopened);
      for (const page of [reopened, b])
        await expect(page.locator('.bn-editor')).toContainText('Fermeture3c');
      await expect(reopened.getByLabel('Health', { exact: true })).toHaveValue('42');
      await expect
        .poll(
          async () =>
            (await cache(reopened)).documents
              .filter((p) => p.page === fixture.page)
              .flatMap((p) => p.pending).length,
        )
        .toBe(0);
      assert.equal(
        await reopened
          .getByRole('list', { name: 'Personnes connectées' })
          .getByText(fixture.accounts[0].name, { exact: true })
          .evaluate((el) => globalThis.getComputedStyle(el).color),
        color,
      );
      console.log(
        'PASS offline update retained in real IndexedDB after tab close, restored after online authorization, merged and acknowledged',
      );
      const sleeper = await lifecycle.page();
      await openPage(sleeper);
      const cdp = await contexts[0].newCDPSession(sleeper);
      await cdp.send('Network.enable');
      await cdp.send('Network.emulateNetworkConditions', {
        offline: true,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await expect(sleeper.getByTestId('save-status')).toContainText('Hors ligne');
      await sleeper.locator('.bn-editor').press('Control+Home');
      await sleeper.keyboard.insertText('LatePrivate3c ');
      await expect(sleeper.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      await expect(b.locator('.bn-editor')).not.toContainText('LatePrivate3c');
      await reopened.bringToFront();
      const resume = await lifecycle.freeze(sleeper);
      await reopened.goto(origin);
      await reopened.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await reopened
        .getByRole('button', { name: 'Effacer les copies locales et se déconnecter', exact: true })
        .click();
      await expect(reopened).toHaveURL(/\/connexion$/);
      assert.deepEqual(await cache(reopened), { documents: [], updates: 0 });
      await cdp.send('Network.emulateNetworkConditions', {
        offline: false,
        latency: 0,
        downloadThroughput: -1,
        uploadThroughput: -1,
      });
      await resume();
      await expect(sleeper.getByText('Session fermée sur ce poste.', { exact: true })).toBeVisible({
        timeout: 10000,
      });
      await expect(sleeper.locator('.bn-editor')).toHaveCount(0);
      assert.deepEqual(await cache(reopened), { documents: [], updates: 0 });
      await expect(b.locator('.bn-editor')).not.toContainText('LatePrivate3c');
      assert((await cache(b)).updates > 0);
      const legacy = await reopened.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const r = globalThis.indexedDB.open('memoria-local-drafts-v1');
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const result = {
                version: r.result.version,
                stores: Array.from(r.result.objectStoreNames),
              };
              r.result.close();
              resolve(result);
            };
          }),
      );
      assert.deepEqual(legacy, { version: 2, stores: ['retired'] });
      assert.deepEqual(errors, []);
      console.log(
        'PASS first-load legacy purge; logout erases all Yjs content and pending metadata, frozen tab cannot resurrect it; other account retained',
      );
      const revoked = await contexts[1].request.post(origin + '/api/auth/sign-out', {
        headers: { Origin: origin },
        data: {},
      });
      assert(revoked.ok());
      await expect(b.getByText('Vos accès ont changé.', { exact: false })).toBeVisible({
        timeout: 10000,
      });
      await expect(b.locator('.bn-editor')).toHaveCount(0);
      await expect.poll(async () => (await cache(b)).updates).toBe(0);
      assert((await cache(b)).documents.every((p) => p.pending.length === 0 && p.count === 0));
      assert.deepEqual(errors, []);
      console.log(
        'PASS server session revocation closes the cached editor and erases its page updates',
      );
    } finally {
      for (const context of contexts) if (context !== lifecycle.context) await context.close();
      await lifecycle.close();
      await browser.close();
    }
  },
);
