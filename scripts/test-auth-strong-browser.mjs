import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { createRequire } from 'node:module';
import { mkdir } from 'node:fs/promises';
import { chromium, expect } from '@playwright/test';
import { testOtp } from '../packages/auth/src/testing/otp.ts';

const origin = process.env.APP_ORIGIN;
if (
  origin !== 'https://localhost' ||
  process.env.NODE_ENV === 'production' ||
  process.env.SMTP_HOST !== '127.0.0.1'
)
  throw new Error('Requires local Caddy, Mailpit and the development database.');
const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await mkdir('.local', { recursive: true });
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
  '4a HTTPS UI: TOTP, common codes, WebAuthn UV, naming and restricted password sign-in',
  { timeout: 120000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const email = `security4a-${randomUUID()}@example.test`,
      password = randomBytes(24).toString('base64url');
    let userId;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const signup = await context.request.post(origin + '/api/auth/sign-up/email', {
        headers: { Origin: origin },
        data: { email, password, name: 'Relecture sécurité', callbackURL: '/connexion' },
      });
      assert.equal(signup.status(), 200, 'Signup failed; check the current per-IP quota.');
      userId = (await signup.json()).user.id;
      assert((await context.request.get(await verificationLink(email))).ok());
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (e) => errors.push(e.message));
      const cdp = await context.newCDPSession(page);
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
      await page.goto(origin + '/connexion');
      await page.getByLabel('Adresse email').fill(email);
      await page.getByLabel('Mot de passe', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Créer un espace', exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Sécurité du compte' }).click();
      await page.getByLabel('Mot de passe actuel', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Configurer une application de codes' }).click();
      await expect(page.locator('code')).toBeVisible();
      const otp = testOtp(
        'otpauth://totp/test?secret=' + (await page.locator('code').textContent()),
      );
      await page
        .getByLabel('Code de l’application')
        .fill(await otp.hotp(Math.floor(Date.now() / 30000) - 1));
      await page.getByRole('button', { name: 'Vérifier le code', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Codes de secours' })).toBeVisible();
      assert.equal((await page.locator('pre').textContent()).trim().split('\n').length, 10);
      await expect(
        page.getByText('Vérifiez votre identité pour ouvrir vos espaces.', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'J’ai conservé mes codes' }).click();
      await page.getByLabel('Code de l’application').fill(await otp.totp());
      await page.getByRole('button', { name: 'Vérifier le code', exact: true }).click();
      await expect(
        page.getByText('Vous êtes connecté avec un facteur fort.', { exact: true }),
      ).toBeVisible();
      console.log(
        'PASS Mailpit, HTTPS login, TOTP enrollment, ten codes and separate strong authentication',
      );
      await page.getByLabel('Nom de la passkey', { exact: true }).fill('Clé du navigateur');
      await page.getByRole('button', { name: 'Ajouter une passkey', exact: true }).click();
      await expect(
        page.getByText('Vérifiez votre identité pour ouvrir vos espaces.', { exact: true }),
      ).toBeVisible();
      await page.getByRole('button', { name: 'Vérifier avec une passkey' }).click();
      await expect(
        page.getByText('Vous êtes connecté avec un facteur fort.', { exact: true }),
      ).toBeVisible();
      await page.getByLabel('Nom de la passkey enregistrée').fill('Clé renommée');
      await page.getByRole('button', { name: 'Renommer', exact: true }).click();
      await expect(page.getByRole('button', { name: 'Renommer', exact: true })).toBeEnabled();
      await page.reload();
      await expect(page.getByLabel('Nom de la passkey enregistrée')).toHaveValue('Clé renommée');
      await page.screenshot({ path: '.local/session-4a-security.png', fullPage: true });
      console.log(
        'PASS virtual WebAuthn UV registration, explicit proof, rename persisted and secret-free screen',
      );
      await page.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await page.getByRole('button', { name: 'Effacer les copies et se déconnecter' }).click();
      await expect(page).toHaveURL(origin + '/connexion');
      await page.getByLabel('Adresse email').fill(email);
      await page.getByLabel('Mot de passe', { exact: true }).fill(password);
      await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect(page).toHaveURL(origin + '/securite');
      assert.equal((await context.request.get(origin + '/api/internal/workspaces')).status(), 403);
      await page.getByRole('button', { name: 'Vérifier avec une passkey' }).click();
      await expect(
        page.getByText('Vous êtes connecté avec un facteur fort.', { exact: true }),
      ).toBeVisible();
      await page.getByRole('link', { name: 'Mes espaces', exact: true }).click();
      await expect(
        page.getByRole('heading', { name: 'Créer un espace', exact: true }),
      ).toBeVisible();
      assert.deepEqual(errors, []);
      console.log(
        'PASS sign-out, password challenge denies content, UV reauthentication restores access; no page errors',
      );
    } finally {
      await browser.close();
      // Delete only this run's random test account; normal application accounts are untouched.
      if (userId)
        await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [userId, email]);
      await pool.end();
    }
  },
);
