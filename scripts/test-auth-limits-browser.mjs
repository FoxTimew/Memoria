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
  throw new Error('Local Caddy/Mailpit only');
const { Pool } = createRequire(new URL('../packages/db/package.json', import.meta.url))('pg');
const pool = new Pool({ connectionString: process.env.DATABASE_URL });
await test(
  '4d browser: generic verification resend, visible wait, successful password after five failures',
  { timeout: 60000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const email = `limits4d-${randomUUID()}@example.test`,
      password = randomBytes(24).toString('base64url');
    let userId;
    try {
      const context = await browser.newContext();
      // A freshly restarted API may not yet be listening behind Caddy.
      const deadline = Date.now() + 15000;
      for (;;) {
        const health = await Promise.all(
          ['/api/health', '/api/health/worker'].map((path) => context.request.get(origin + path)),
        );
        if (health.every((response) => response.ok())) break;
        assert.ok(Date.now() < deadline, 'API and worker must become ready');
        await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
      }
      const post = (path, data) =>
        context.request.post(origin + '/api/auth' + path, { headers: { Origin: origin }, data });
      const signup = await post('/sign-up/email', {
        email,
        password,
        name: 'Limits fixture',
        callbackURL: '/connexion',
      });
      assert.equal(signup.status(), 200);
      userId = (await signup.json()).user.id;
      let link;
      for (let n = 0; n < 80 && !link; n++) {
        const list = await (
          await globalThis.fetch(
            `http://127.0.0.1:8025/api/v1/search?query=${encodeURIComponent('to:' + email)}`,
          )
        ).json();
        for (const m of list.messages ?? []) {
          const detail = await (
            await globalThis.fetch(`http://127.0.0.1:8025/api/v1/message/${m.ID}`)
          ).json();
          link = detail.Text.match(/https:\/\/localhost\/api\/auth\/verify-email\?[^\s]+/)?.[0];
          if (link) break;
        }
        if (!link) await new Promise((resolve) => globalThis.setTimeout(resolve, 250));
      }
      assert.ok(link);
      assert.ok((await context.request.get(link)).ok());
      const known = await post('/send-verification-email', { email }),
        unknown = await post('/send-verification-email', { email: `${randomUUID()}@example.test` });
      assert.equal(known.status(), 200);
      assert.equal(unknown.status(), 200);
      assert.deepEqual(await known.json(), await unknown.json());
      for (let n = 0; n < 5; n++)
        assert.equal(
          (await post('/sign-in/email', { email, password: 'invalid-password' })).status(),
          401,
        );
      const page = await context.newPage(),
        errors = [];
      page.on('pageerror', (error) => errors.push(error.message));
      await page.goto(origin + '/connexion');
      await page.getByLabel('Adresse email').fill(email);
      await page.getByLabel('Mot de passe', { exact: true }).fill(password);
      const began = Date.now();
      await page.getByRole('button', { name: 'Se connecter', exact: true }).click();
      await expect(
        page.getByRole('status').filter({ hasText: 'Vérification en cours' }),
      ).toBeVisible();
      await expect(page.getByRole('button', { name: 'Un instant…', exact: true })).toBeDisabled();
      await page.screenshot({ path: '.local/session-4d-wait.png', fullPage: true });
      await expect(page).toHaveURL(origin + '/');
      assert.ok(Date.now() - began >= 950);
      assert.deepEqual(errors, []);
      console.info(
        'PASS HTTPS signup through worker/Mailpit, generic verification response, five failed passwords, visible pending state, correct password accepted after delay.',
      );
    } finally {
      await browser.close();
      if (userId)
        await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [userId, email]);
      await pool.end();
    }
  },
);
