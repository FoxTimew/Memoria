import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';

const origin = process.env.APP_ORIGIN;
if (
  origin !== 'https://localhost' ||
  process.env.NODE_ENV === 'production' ||
  process.env.SMTP_HOST !== '127.0.0.1'
)
  throw new Error('Requires local Caddy, development database and Mailpit.');
const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function mailLink(email, pattern) {
  for (let i = 0; i < 100; i++) {
    const list = await (
      await globalThis.fetch(
        `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
      )
    ).json();
    for (const message of list.messages ?? []) {
      const detail = await (
        await globalThis.fetch(`http://127.0.0.1:8025/api/v1/message/${message.ID}`)
      ).json();
      const link = detail.Text.match(pattern)?.[0];
      if (link) return link;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error('Expected test email missing');
}
async function call(context, path, data, method = 'POST', expected = 200) {
  const response = await context.request.fetch(origin + path, {
    method,
    headers: { Origin: origin },
    ...(data === undefined ? {} : { data }),
  });
  assert.equal(response.status(), expected, 'HTTP fixture ' + path);
  return response.json();
}
async function virtualKey(page) {
  const cdp = await page.context().newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
}
async function enrollAndProve(page) {
  await page.getByLabel('Nom de la passkey', { exact: true }).fill('5b browser key');
  await page.getByRole('button', { name: 'Ajouter une passkey', exact: true }).click();
  await expect(page.getByRole('region', { name: 'Codes de secours' })).toBeVisible();
  await expect(page.getByRole('link', { name: 'Reprendre mon action' })).toHaveCount(0);
  await page.getByRole('button', { name: 'J’ai conservé mes codes' }).click();
  await page.getByRole('button', { name: 'Vérifier avec une passkey' }).click();
  await expect(page.getByRole('link', { name: 'Reprendre mon action' })).toBeVisible();
  await page.getByRole('link', { name: 'Reprendre mon action' }).click();
}
await test(
  '5b HTTPS UI: retained invitation form, real SMTP, verified recipient and guided MFA arrival',
  { timeout: 180000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const accounts = [],
      errors = [];
    let workspace;
    try {
      const owner = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const recipient = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const ownerEmail = `owner5b-${randomUUID()}@example.test`,
        recipientEmail = `recipient5b-${randomUUID()}@example.test`;
      const password = randomBytes(24).toString('base64url');
      const createAccount = async (context, email, name) => {
        const result = await call(context, '/api/auth/sign-up/email', {
          email,
          password,
          name,
          callbackURL: '/connexion',
        });
        accounts.push({ id: result.user.id, email });
        assert(
          (
            await context.request.get(
              await mailLink(email, /https:\/\/localhost\/api\/auth\/verify-email\?[^\s]+/),
            )
          ).ok(),
        );
      };
      await createAccount(owner, ownerEmail, 'Owner 5b browser');
      await call(owner, '/api/auth/sign-in/email', { email: ownerEmail, password });
      workspace = (
        await call(
          owner,
          '/api/internal/workspaces',
          { name: 'Studio 5b navigateur', slug: 'browser5b-' + randomUUID() },
          'POST',
          201,
        )
      ).id;
      const base = `/api/internal/workspaces/${workspace}`;
      const page = await owner.newPage();
      page.on('pageerror', (e) => errors.push(e.message));
      await virtualKey(page);
      await page.goto(`${origin}/workspaces/${workspace}/acces`);
      await page.getByLabel('Adresse email').fill(recipientEmail);
      await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
      await expect(
        page.getByRole('region', { name: 'Seconde vérification requise' }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Configurer ou vérifier mon identité' }).click();
      await enrollAndProve(page);
      await expect(page.getByLabel('Adresse email')).toHaveValue(recipientEmail);
      assert.equal(
        (await call(owner, base + '/invitations', undefined, 'GET')).length,
        0,
        'return never automatically submits',
      );
      // Enable the workspace policy after the optional-workspace guidance was exercised.
      const policy = await call(owner, base + '/security', undefined, 'GET');
      await call(
        owner,
        base + '/security',
        { expectedVersion: policy.version, requireStrongAuth: true, graceDays: 7 },
        'PUT',
      );
      await page.getByRole('button', { name: 'Envoyer l’invitation' }).click();
      await expect(page.getByLabel('Lien de la nouvelle invitation')).toBeVisible();
      const link = await page.getByLabel('Lien de la nouvelle invitation').inputValue();
      assert.equal(
        await mailLink(recipientEmail, /https:\/\/localhost\/invitation#id=[^\s]+/),
        link,
      );
      await page.screenshot({ path: '.local/session-5b-access.png', fullPage: true });
      const newcomer = await recipient.newPage(),
        urls = [];
      newcomer.on('pageerror', (e) => errors.push(e.message));
      newcomer.on('request', (request) => urls.push(request.url()));
      await virtualKey(newcomer);
      await newcomer.goto(link);
      await expect(newcomer).toHaveURL(origin + '/invitation');
      await expect(newcomer.getByText('Studio 5b navigateur', { exact: true })).toHaveCount(0);
      // The pending fragment survives registration/verification and the actual login UI.
      await createAccount(recipient, recipientEmail, 'Recipient 5b browser');
      await newcomer.goto(origin + '/connexion');
      await newcomer.getByLabel('Adresse email').fill(recipientEmail);
      await newcomer.getByLabel('Mot de passe', { exact: true }).fill(password);
      await newcomer.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect(newcomer).toHaveURL(origin + '/invitation');
      await expect(newcomer.getByText('Studio 5b navigateur', { exact: true })).toBeVisible();
      await newcomer.getByRole('button', { name: 'Accepter l’invitation' }).click();
      await expect(newcomer).toHaveURL(`${origin}/workspaces/${workspace}/arrivee`);
      await expect(
        newcomer.getByText('Ce studio protège ses documents', { exact: false }),
      ).toBeVisible();
      assert.equal((await recipient.request.get(origin + base + '/pages')).status(), 403);
      await newcomer.screenshot({ path: '.local/session-5b-arrival.png', fullPage: true });
      await newcomer.getByRole('link', { name: 'Configurer ou vérifier mon identité' }).click();
      await enrollAndProve(newcomer);
      await expect(newcomer.getByRole('link', { name: 'Ouvrir le studio' })).toBeVisible();
      assert.equal((await recipient.request.get(origin + base + '/pages')).status(), 200);
      assert(
        urls.every((url) => !url.includes(new URL(link).hash.slice(4))),
        'invitation ID never sent in a network URL',
      );
      assert.deepEqual(errors, []);
      console.log(
        'PASS owner without factor guided and form retained; explicit submission; real worker/Mailpit; anonymous metadata hidden; verified recipient; no grace/content before independent UV proof; no browser errors',
      );
    } finally {
      await browser.close();
      if (workspace) await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
      for (const account of accounts)
        await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [
          account.id,
          account.email,
        ]);
      await pool.end();
    }
  },
);
