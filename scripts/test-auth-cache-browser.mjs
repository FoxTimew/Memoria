import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import { testOtp } from '../packages/auth/src/testing/otp.ts';

const origin = process.env.APP_ORIGIN;
if (origin !== 'https://localhost' || process.env.NODE_ENV === 'production')
  throw new Error('Local development only');
const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await test(
  '4e HTTPS: three tabs, offline frozen tab, policy purge, shared login and logout',
  { timeout: 180000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const context = await browser.newContext({ viewport: { width: 1440, height: 1080 } });
    const email = `cache4e-${randomUUID()}@example.test`,
      password = randomBytes(24).toString('base64url');
    let user, workspace;
    const errors = [];
    const request = async (
      path,
      data,
      method = data === undefined ? 'GET' : 'POST',
      headers = {},
    ) => {
      const response = await context.request.fetch(
        origin + (path.startsWith('/api/') ? path : '/api/auth' + path),
        {
          method,
          headers: { Origin: origin, ...headers },
          ...(data === undefined ? {} : { data }),
        },
      );
      assert(response.ok(), `${path}: ${response.status()} ${await response.text()}`);
      return response.json();
    };
    async function records(page) {
      return page.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const read = globalThis.indexedDB.open('memoria-yjs-cache-v1');
            read.onerror = () => reject(read.error);
            read.onsuccess = () => {
              const db = read.result,
                tx = db.transaction(['documents', 'updates']),
                docs = tx.objectStore('documents').getAll(),
                updates = tx.objectStore('updates').getAll();
              tx.oncomplete = () => {
                db.close();
                resolve({
                  docs: docs.result,
                  updates: updates.result.map((u) => ({ user: u.user, bytes: u.data.length })),
                });
              };
            };
          }),
      );
    }
    try {
      for (let i = 0; i < 60; i++) {
        if ((await context.request.get(origin + '/api/health')).ok()) break;
        await new Promise((r) => globalThis.setTimeout(r, 250));
      }
      user = (
        await request('/sign-up/email', {
          email,
          password,
          name: 'Cache 4e',
          callbackURL: '/connexion',
        })
      ).user.id;
      // Fixture verification only; email delivery is covered by 4c/4d suites.
      await pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [user]);
      await request('/sign-in/email', { email, password });
      const uri = (await request('/two-factor/enable', { password })).totpURI;
      const otp = testOtp(uri),
        step = Math.floor(Date.now() / 30000);
      for (const n of [step - 1, step]) {
        const challenge = await request('/security/challenge', {});
        await request('/two-factor/verify-totp', { code: await otp.hotp(n) }, 'POST', {
          'x-memoria-challenge': challenge.id,
        });
      }
      workspace = (
        await request('/api/internal/workspaces', {
          name: 'Cache 4e test',
          slug: 'cache4e-' + randomUUID(),
        })
      ).id;
      const base = `/api/internal/workspaces/${workspace}`,
        title = 'Cache 4e ' + randomUUID().slice(0, 8);
      await request(base + '/pages', { title, parentId: null });
      const tabs = await Promise.all([context.newPage(), context.newPage(), context.newPage()]);
      const [a, b, c] = tabs;
      const open = async (page) => {
        await page.goto(origin + `/workspaces/${workspace}`);
        await page
          .getByRole('navigation', { name: 'Arbre des pages' })
          .getByRole('button', { name: new RegExp(title) })
          .click();
        await expect(page.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
          timeout: 20000,
        });
        await expect(page.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      };
      for (const page of tabs) {
        page.on('pageerror', (e) => errors.push(e.message));
        await open(page);
      }
      const editor = (page) => page.locator('.bn-editor[contenteditable="true"]');
      await editor(a).fill('Texte partagé');
      await expect(a.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
      await expect(c.locator('.bn-editor')).toContainText('Texte partagé');
      // A different account's content in the SAME origin must survive both kinds of purge.
      await a.evaluate(
        () =>
          new Promise((resolve, reject) => {
            const r = globalThis.indexedDB.open('memoria-yjs-cache-v1');
            r.onerror = () => reject(r.error);
            r.onsuccess = () => {
              const db = r.result,
                tx = db.transaction(['documents', 'updates'], 'readwrite');
              tx.objectStore('documents').put({
                key: 'other-account-fixture',
                user: 'other-account',
                workspace: 'other',
                page: 'p',
                generation: 'g',
                epoch: 0,
                count: 1,
                bytes: 1,
                pending: [],
              });
              tx.objectStore('updates').add({
                key: 'other-account-fixture',
                user: 'other-account',
                data: new Uint8Array([0]),
              });
              tx.oncomplete = () => {
                db.close();
                resolve();
              };
            };
          }),
      );
      await c.route('**/api/**', (route) => route.abort());
      await c.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('offline')));
      await editor(c).press('Control+End');
      await editor(c).pressSequentially(' Travail hors ligne 4e');
      await expect(c.getByTestId('save-status')).toContainText('Hors ligne');
      await expect(c.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      const cdp = await context.newCDPSession(c);
      await cdp.send('Page.setWebLifecycleState', { state: 'frozen' });
      // Independent browser storage: the administrator cannot notify the editors locally.
      const administrator = await browser.newContext();
      await administrator.addCookies(await context.cookies());
      const policyPage = await administrator.newPage();
      await policyPage.goto(origin + `/workspaces/${workspace}/securite`);
      const checkbox = policyPage.getByLabel(
        'Autoriser les copies locales des pages pour les membres',
      );
      await checkbox.uncheck();
      policyPage.once('dialog', (dialog) => {
        assert.match(dialog.message(), /synchroniser ou exporter/);
        return dialog.accept();
      });
      const banStarted = Date.now();
      await policyPage.getByRole('button', { name: 'Enregistrer la politique' }).click();
      await expect(policyPage.getByRole('status')).toContainText('Politique enregistrée');
      await expect(a.getByTestId('local-save-status')).toContainText('Copie locale désactivée', {
        timeout: 7000,
      });
      await expect
        .poll(async () => (await records(a)).docs.filter((d) => d.user === user).length)
        .toBe(0);
      assert.equal((await records(a)).docs.filter((d) => d.user === 'other-account').length, 1);
      const observedPurge = Date.now() - banStarted;
      assert(observedPurge < 5000, `Remote policy purge took ${observedPurge} ms`);
      console.log(
        `Remote policy purge observed in ${observedPurge} ms (functional deadline, not a performance benchmark).`,
      );
      await cdp.send('Page.setWebLifecycleState', { state: 'active' });
      await expect(c.getByTestId('local-save-status')).toContainText('Copie locale désactivée');
      await editor(c).pressSequentially(' après réveil');
      assert.equal((await records(a)).updates.filter((d) => d.user === user).length, 0);
      await c.unroute('**/api/**');
      await c.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('online')));
      await expect(a.locator('.bn-editor')).toContainText('Travail hors ligne 4e', {
        timeout: 15000,
      });
      console.log(
        'PASS remote workspace ban, three tabs including frozen offline writer, purge, memory retained, reconnect convergence, other account preserved',
      );
      await checkbox.check();
      await policyPage.getByRole('button', { name: 'Enregistrer la politique' }).click();
      await expect(policyPage.getByRole('status')).toContainText('Politique enregistrée');
      await open(a);
      await expect
        .poll(async () => (await records(a)).updates.filter((d) => d.user === user).length)
        .toBeGreaterThan(0);
      await b.goto(origin + '/connexion');
      await expect(b.getByLabel(/Poste partagé/)).not.toBeChecked();
      await b.getByLabel('Adresse email').fill(email);
      await b.getByLabel('Mot de passe', { exact: true }).fill(password);
      await b.getByLabel(/Poste partagé/).check();
      b.once('dialog', (dialog) => {
        assert.match(dialog.message(), /synchroniser ou les exporter/);
        return dialog.accept();
      });
      await b.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect(b).toHaveURL(origin + '/securite');
      assert.equal((await request('/security/cache-policy')).sharedComputer, true);
      await expect
        .poll(async () => (await records(b)).docs.filter((d) => d.user === user).length)
        .toBe(0);
      const challenge = await request('/security/challenge', {});
      await request(
        '/two-factor/verify-totp',
        { code: await otp.hotp(Math.floor(Date.now() / 30000) + 1) },
        'POST',
        { 'x-memoria-challenge': challenge.id },
      );
      assert.equal((await request('/security/cache-policy')).sharedComputer, true);
      await b.goto(origin + `/workspaces/${workspace}`);
      await b
        .getByRole('navigation', { name: 'Arbre des pages' })
        .getByRole('button', { name: new RegExp(title) })
        .click();
      await expect(b.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
      await expect(b.getByTestId('local-save-status')).toContainText('Copie locale désactivée');
      await b.route('**/api/**', (route) => route.abort());
      await b.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('offline')));
      await editor(b).press('Control+End');
      await editor(b).pressSequentially(' mémoire seulement');
      await expect(b.getByText(/fermer ou recharger cet onglet perdra/)).toBeVisible();
      assert.equal((await records(b)).updates.filter((d) => d.user === user).length, 0);
      await b.screenshot({ path: '.local/session-4e-shared.png', fullPage: true });
      await b.unroute('**/api/**');
      await b.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('online')));
      await expect(b.getByTestId('save-status')).toHaveText('Enregistré sur le serveur', {
        timeout: 15000,
      });
      await b.goto(origin + '/');
      await b.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await b
        .getByRole('button', { name: 'Effacer les copies locales et se déconnecter', exact: true })
        .click();
      await expect(b).toHaveURL(origin + '/connexion');
      assert.equal((await records(b)).updates.filter((d) => d.user === user).length, 0);
      assert.equal((await records(b)).updates.filter((d) => d.user === 'other-account').length, 1);
      assert.deepEqual(errors, []);
      console.log(
        'PASS shared checkbox warning, server choice, TOTP rotation, memory-only offline editing, logout and other-account preservation; no page errors',
      );
    } finally {
      await browser.close();
      if (workspace) await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
      if (user) await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [user, email]);
      await pool.end();
    }
  },
);
