import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import { testOtp } from '../packages/auth/src/testing/otp.ts';
const origin = process.env.APP_ORIGIN;
if (
  origin !== 'https://localhost' ||
  process.env.NODE_ENV === 'production' ||
  process.env.SMTP_HOST !== '127.0.0.1'
)
  throw new Error('Local development Caddy/Mailpit required');
const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
async function mailLink(email, pattern) {
  for (let i = 0; i < 80; i++) {
    const list = await (
      await globalThis.fetch(
        `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
      )
    ).json();
    for (const m of list.messages ?? []) {
      const detail = await (
        await globalThis.fetch(`http://127.0.0.1:8025/api/v1/message/${m.ID}`)
      ).json();
      const link = detail.Text.match(pattern)?.[0];
      if (link) return link;
    }
    await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
  }
  throw new Error('Expected test email missing');
}
await test(
  '4c HTTPS browser, real worker/Mailpit, reset then restricted recovery and new UV proof',
  { timeout: 120000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const email = `recovery4c-${randomUUID()}@example.test`,
      password = randomBytes(24).toString('base64url');
    let userId;
    try {
      const context = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const post = async (path, data, extra = {}) => {
        const r = await context.request.post(origin + '/api/auth' + path, {
          headers: { Origin: origin, ...extra },
          data,
        });
        assert.equal(r.status(), 200, 'HTTP fixture ' + path);
        return r.json();
      };
      userId = (
        await post('/sign-up/email', {
          email,
          password,
          name: 'Recovery test',
          callbackURL: '/connexion',
        })
      ).user.id;
      assert(
        (
          await context.request.get(
            await mailLink(email, /https:\/\/localhost\/api\/auth\/verify-email\?[^\s]+/),
          )
        ).ok(),
      );
      await post('/sign-in/email', { email, password });
      const setup = await post('/two-factor/enable', { password });
      const otp = testOtp(setup.totpURI);
      const challenge = await post('/security/challenge', {});
      const codes = (
        await post(
          '/two-factor/verify-totp',
          { code: await otp.hotp(Math.floor(Date.now() / 30000) - 1) },
          { 'x-memoria-challenge': challenge.id },
        )
      ).recoveryCodes;
      const page = await context.newPage(),
        errors = [],
        urls = [];
      page.on('pageerror', (e) => errors.push(e.message));
      page.on('request', (r) => urls.push(r.url()));
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
      await page.getByRole('link', { name: 'Mot de passe ou facteur perdu ?' }).click();
      await expect(
        page.getByRole('heading', { name: 'Récupérer votre accès', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Adresse email').fill(email);
      await expect(page.getByLabel('Adresse email')).toHaveValue(email);
      const sent = page.waitForResponse((r) =>
        r.url().endsWith('/security/request-password-reset'),
      );
      await page.getByRole('button', { name: 'Envoyer le lien', exact: true }).click();
      assert.equal((await sent).status(), 200);
      await expect(page.getByRole('status')).toContainText('Si cette adresse correspond');
      const link = await mailLink(email, /https:\/\/localhost\/recuperation#reset=[^\s]+/);
      const token = new URL(link).hash.slice(7);
      await page.goto('about:blank');
      const response = await page.goto(link);
      assert.equal(response.headers()['referrer-policy'], 'no-referrer');
      await expect(page).toHaveURL(origin + '/recuperation');
      await page.getByLabel('Nouveau mot de passe', { exact: true }).fill(password + '-new');
      await page.getByRole('button', { name: 'Changer le mot de passe', exact: true }).click();
      await expect(page.getByRole('status')).toContainText('Votre mot de passe est changé');
      assert(
        urls.every((url) => !url.includes(token)),
        'reset token must never appear in network URL',
      );
      await page.getByRole('link', { name: 'Retour à la connexion' }).click();
      await expect(
        page.getByRole('heading', { name: 'Heureux de vous retrouver.', exact: true }),
      ).toBeVisible();
      await page.getByLabel('Adresse email').fill(email);
      await page.getByLabel('Mot de passe', { exact: true }).fill(password + '-new');
      await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect(page).toHaveURL(origin + '/securite');
      assert.equal((await context.request.get(origin + '/api/internal/workspaces')).status(), 403);
      await page.getByRole('link', { name: 'Mot de passe ou facteur perdu ?' }).click();
      await page
        .getByRole('button', { name: 'J’ai perdu mon facteur : utiliser un code de secours' })
        .click();
      await page.getByLabel('Adresse email').fill(email);
      await page.getByLabel('Mot de passe actuel', { exact: true }).fill(password + '-new');
      await page.getByLabel('Code de secours', { exact: true }).fill(codes[0]);
      await page.getByRole('button', { name: 'Rétablir mes facteurs' }).click();
      await expect(page).toHaveURL(origin + '/securite');
      await expect(
        page.getByText('Récupération en cours, limitée à quinze minutes.', { exact: false }),
      ).toBeVisible();
      assert.equal((await context.request.get(origin + '/api/internal/workspaces')).status(), 403);
      page.once('dialog', (d) => d.accept());
      await page.getByRole('button', { name: 'Retirer l’application de codes perdue' }).click();
      await expect(
        page.getByRole('button', { name: 'Retirer l’application de codes perdue' }),
      ).toHaveCount(0);
      await page.getByLabel('Nom de la passkey', { exact: true }).fill('New recovery key');
      await page.getByRole('button', { name: 'Ajouter une passkey', exact: true }).click();
      await expect(
        page.getByRole('button', { name: 'Terminer la récupération', exact: true }),
      ).toBeEnabled();
      await page.getByRole('button', { name: 'Terminer la récupération', exact: true }).click();
      await expect(page.getByRole('region', { name: 'Codes de secours' })).toBeVisible();
      assert.equal((await page.locator('pre').textContent()).trim().split('\n').length, 10);
      assert.equal((await context.request.get(origin + '/api/internal/workspaces')).status(), 403);
      await page.getByRole('button', { name: 'J’ai conservé mes codes' }).click();
      await page.getByRole('button', { name: 'Vérifier avec une passkey' }).click();
      await expect(
        page.getByText('Vous êtes connecté avec un facteur fort.', { exact: true }),
      ).toBeVisible();
      assert.equal((await context.request.get(origin + '/api/internal/workspaces')).status(), 200);
      await page.screenshot({ path: '.local/session-4c-recovery.png', fullPage: true });
      assert.deepEqual(errors, []);
      console.log(
        'PASS reset through Mailpit worker; fragment removed, no token in request URLs; password does not bypass factor; recovery UI replaces TOTP with passkey, renews codes and requires separate UV proof',
      );
    } finally {
      await browser.close();
      if (userId)
        await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [userId, email]);
      await pool.end();
    }
  },
);
