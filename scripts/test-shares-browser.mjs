import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import { lifecycleBrowser } from './browser-lifecycle.mjs';

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
async function records(page) {
  return page.evaluate(
    () =>
      new Promise((resolve, reject) => {
        const request = globalThis.indexedDB.open('memoria-yjs-cache-v1');
        request.onerror = () => reject(request.error);
        request.onsuccess = () => {
          const db = request.result,
            tx = db.transaction(['documents', 'updates']);
          const docs = tx.objectStore('documents').getAll(),
            updates = tx.objectStore('updates').getAll();
          tx.oncomplete = () => {
            db.close();
            resolve({
              docs: docs.result,
              updates: updates.result.map((u) => ({ id: u.id, key: u.key, user: u.user })),
            });
          };
        };
      }),
  );
}
await test(
  '5d HTTPS: targeted invalidation, guided shares, partial tree, read-only, frozen cache and move preview',
  { timeout: 240000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const accounts = [],
      errors = [];
    const lifecycle = await lifecycleBrowser();
    let workspace;
    try {
      const owner = await browser.newContext({ viewport: { width: 1440, height: 1100 } }),
        guest = lifecycle.context;
      const regular = await browser.newContext({ viewport: { width: 1440, height: 1100 } });
      const password = randomBytes(24).toString('base64url');
      async function account(context, name) {
        const email = `share5c-${randomUUID()}@example.test`;
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
        await call(context, '/api/auth/sign-in/email', { email, password });
        return result.user.id;
      }
      await account(owner, 'Owner 5c');
      const guestUser = await account(guest, 'Guest 5c');
      const regularUser = await account(regular, 'Member 5d');
      workspace = (
        await call(
          owner,
          '/api/internal/workspaces',
          { name: 'Studio 5c', slug: 'share5c-' + randomUUID() },
          'POST',
          201,
        )
      ).id;
      const base = `/api/internal/workspaces/${workspace}`;
      const create = async (title, parentId = null) =>
        call(owner, base + '/pages', { title, parentId }, 'POST', 201);
      const hidden = await create('HIDDEN PARENT 5C'),
        root = await create('Shared root 5c', hidden.id),
        child = await create('Shared child 5c', root.id),
        elsewhere = await create('HIDDEN SIBLING 5C');
      // Membership only is a fixture, to exercise the no-factor owner share flow independently
      // of invitations (whose own guided MFA flow is covered by test:invitations:browser).
      const member = randomUUID();
      await pool.query(
        "INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES($1,$2,$3,'guest')",
        [member, guestUser, workspace],
      );
      await pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        guestUser,
      ]);
      await pool.query(
        "INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES($1,$2,$3,'member')",
        [randomUUID(), regularUser, workspace],
      );
      await pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        regularUser,
      ]);
      const meta = await call(owner, `${base}/pages/${child.id}/collaboration`, {}, 'POST', 201);
      const paragraph = randomUUID();
      await call(
        owner,
        `${base}/pages/${child.id}/content`,
        {
          generation: meta.generation,
          expectedRevision: meta.contentRevision,
          receipt: randomUUID(),
          operations: [
            {
              op: 'insert',
              id: paragraph,
              parentId: null,
              afterId: null,
              type: 'core.paragraph',
              schemaVersion: 1,
              content: { spans: [{ type: 'text', text: 'Shared needle 5c', styles: {} }] },
            },
            {
              op: 'insert',
              id: randomUUID(),
              parentId: null,
              afterId: paragraph,
              type: 'gamedev.character-card',
              schemaVersion: 2,
              content: {
                characterId: randomUUID(),
                displayName: 'Personnage partagé',
                archetype: 'npc',
                biography: '',
                health: 100,
                attack: 10,
                tags: [],
              },
            },
          ],
        },
        'PUT',
      );
      const management = await owner.newPage();
      management.on('pageerror', (e) => errors.push(e.message));
      await virtualKey(management);
      await management.goto(`${origin}/workspaces/${workspace}/acces`);
      await management.getByLabel('Page à partager').selectOption(root.id);
      const selection = () => management.getByLabel('Partage direct pour Guest 5c');
      await selection().selectOption('read');
      await management
        .getByRole('button', { name: 'Enregistrer le partage pour Guest 5c' })
        .click();
      await expect(management.getByText('Pour partager cette page, ajoutez')).toBeVisible();
      await management.getByRole('link', { name: 'Configurer ou vérifier mon identité' }).click();
      await enrollAndProve(management);
      await expect(selection()).toHaveValue('read');
      assert.equal(
        (await call(owner, `${base}/pages/${root.id}/shares`, undefined, 'GET')).guests[0].direct,
        null,
        'MFA return never automatically changes access',
      );
      async function change(level) {
        await selection().selectOption(level);
        await management
          .getByRole('button', { name: 'Enregistrer le partage pour Guest 5c' })
          .click();
        await expect(
          management.getByRole('status').filter({ hasText: 'Partage enregistré' }),
        ).toBeVisible();
        await expect(selection()).toHaveValue(level);
      }
      await management
        .getByRole('button', { name: 'Enregistrer le partage pour Guest 5c' })
        .click();
      await expect(
        management.getByRole('status').filter({ hasText: 'Partage enregistré' }),
      ).toBeVisible();
      const reader = await lifecycle.page(),
        frozen = await lifecycle.page(),
        writer = await owner.newPage();
      const memberPage = await regular.newPage();
      const closes = { member: 0, guest: 0 };
      memberPage.on('websocket', (socket) => socket.on('close', () => closes.member++));
      reader.on('websocket', (socket) => socket.on('close', () => closes.guest++));
      for (const p of [reader, frozen, writer, memberPage])
        p.on('pageerror', (e) => errors.push(e.message));
      async function open(p) {
        await p.goto(`${origin}/workspaces/${workspace}`);
        await p
          .getByRole('navigation', { name: 'Arbre des pages' })
          .getByRole('button', { name: 'Shared child 5c', exact: true })
          .click();
        await expect(p.locator('.bn-editor')).toBeVisible({ timeout: 20000 });
        await expect(p.getByTestId('local-save-status')).toHaveText('Copie locale à jour', {
          timeout: 15000,
        });
      }
      await open(reader);
      await open(writer);
      await expect(reader.getByText('Lecture seule :')).toBeVisible();
      await expect(reader.locator('.bn-editor')).toHaveAttribute('contenteditable', 'false');
      await expect(
        reader.getByRole('textbox', { name: 'Titre de la page', exact: true }),
      ).toBeDisabled();
      await expect(reader.getByLabel('Character name')).toBeDisabled();
      await expect(reader.getByRole('button', { name: '+ Sous-page' })).toBeDisabled();
      await expect(reader.getByRole('button', { name: 'Déplacer', exact: true })).toHaveCount(0);
      assert(!(await reader.locator('main').innerText()).includes('HIDDEN'));
      await reader.getByLabel('Rechercher dans l’espace').fill('HIDDEN');
      await expect(reader.getByRole('region', { name: 'Résultats de recherche' })).toContainText(
        'Aucun résultat.',
      );
      await writer.getByLabel('Character name').fill('Personnage en direct');
      await expect(reader.getByLabel('Character name')).toHaveValue('Personnage en direct');
      await reader.screenshot({ path: '.local/session-5c-read.png', fullPage: true });
      console.log(
        'PASS retained no-factor share action; partial tree/search/breadcrumbs; read-only title, text and character card; live updates received',
      );
      await open(memberPage);
      const ids = async (page) => (await records(page)).updates.map((u) => u.id);
      const memberCache = await ids(memberPage),
        guestCache = await ids(reader);
      const unrelated = await create('Unrelated archive 5d');
      await call(
        owner,
        `${base}/pages/${unrelated.id}/archive`,
        { expectedVersion: unrelated.version },
        'POST',
        201,
      );
      const body = { expectedVersion: root.version, parentId: elsewhere.id, afterId: null };
      const unchanged = await call(
        owner,
        `${base}/pages/${root.id}/move/preview`,
        body,
        'POST',
        201,
      );
      assert.deepEqual(unchanged.effects, [], 'the direct root share follows the subtree');
      await call(
        owner,
        `${base}/pages/${root.id}/move`,
        { ...body, previewToken: unchanged.token },
        'POST',
        201,
      );
      await new Promise((resolve) => globalThis.setTimeout(resolve, 5200));
      assert.deepEqual(
        closes,
        { member: 0, guest: 0 },
        'unrelated archive/ineffective move must not close live sockets',
      );
      assert.deepEqual(
        await ids(memberPage),
        memberCache,
        'unaffected member cache bytes retained, not rebuilt',
      );
      assert.deepEqual(
        await ids(reader),
        guestCache,
        'unaffected guest cache bytes retained, not rebuilt',
      );
      await expect(memberPage.locator('.bn-editor')).toBeVisible();
      await expect(reader.locator('.bn-editor')).toBeVisible();
      console.log(
        'PASS 5d targeted invalidation: unrelated archive and ineffective move preserve member/guest sockets and original IndexedDB update IDs',
      );
      // Refresh management's CAS snapshot after the unrelated tree change.
      await management.reload();
      await management.getByLabel('Page à partager').selectOption(root.id);
      await change('edit');
      await expect(reader.locator('.bn-editor')).toHaveCount(0, { timeout: 10000 });
      await open(reader);
      await open(frozen);
      await expect(
        reader.getByRole('textbox', { name: 'Titre de la page', exact: true }),
      ).toBeEnabled();
      await reader.getByLabel('Character name').fill('Invité éditeur');
      await expect(writer.getByLabel('Character name')).toHaveValue('Invité éditeur');
      await expect
        .poll(async () => (await records(reader)).docs.filter((d) => d.user === guestUser).length)
        .toBeGreaterThan(0);
      await frozen.route('**/api/**', (route) => route.abort());
      await frozen.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('offline')));
      await frozen.locator('.bn-editor [data-content-type="paragraph"]').first().press('End');
      await frozen.locator('.bn-editor').press('Control+End');
      await frozen.locator('.bn-editor').pressSequentially(' OFFLINE_REVOKED_5C');
      await expect(frozen.locator('.bn-editor')).toContainText('OFFLINE_REVOKED_5C');
      await expect(frozen.getByTestId('save-status')).toContainText('Hors ligne');
      await expect(frozen.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      const resume = await lifecycle.freeze(frozen);
      await change('read');
      await expect(reader.locator('.bn-editor')).toHaveCount(0, { timeout: 10000 });
      await expect
        .poll(
          async () =>
            (await records(reader)).docs.filter(
              (d) => d.user === guestUser && d.workspace === workspace,
            ).length,
        )
        .toBe(0);
      await change('edit');
      await resume();
      await frozen.unroute('**/api/**');
      await frozen.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('online')));
      await expect(frozen.locator('.bn-editor')).toHaveCount(0, { timeout: 10000 });
      await expect(frozen.getByRole('button', { name: 'Exporter le travail local' })).toBeVisible();
      const exported = await lifecycle.download(() =>
        frozen.getByRole('button', { name: 'Exporter le travail local' }).click(),
      );
      assert(
        exported.includes('OFFLINE_REVOKED_5C'),
        `Missing offline fixture in export: ${exported}`,
      );
      const projected = await call(owner, `${base}/pages/${child.id}`, undefined, 'GET');
      assert(!JSON.stringify(projected).includes('OFFLINE_REVOKED_5C'));
      await open(reader);
      assert(!(await reader.locator('.bn-editor').innerText()).includes('OFFLINE_REVOKED_5C'));
      console.log(
        'PASS online downgrade purges affected pages; offline frozen editor cannot resurrect its cache or replay after regrant; memory export retained',
      );
      await change('none');
      await expect(reader.locator('.bn-editor')).toHaveCount(0, { timeout: 10000 });
      await expect
        .poll(
          async () =>
            (await records(reader)).docs.filter(
              (d) => d.user === guestUser && d.workspace === workspace,
            ).length,
        )
        .toBe(0);
      // No awake guest tab receives the revocation in this second scenario.
      await change('edit');
      await open(frozen);
      await reader.close();
      await frozen.route('**/api/**', (route) => route.abort());
      await frozen.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('offline')));
      await frozen.locator('.bn-editor').press('Control+End');
      await frozen.locator('.bn-editor').pressSequentially(' SOLE_OFFLINE_5C');
      await expect(frozen.locator('.bn-editor')).toContainText('SOLE_OFFLINE_5C');
      await expect(frozen.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      const resumeSole = await lifecycle.freeze(frozen);
      await change('none');
      await resumeSole();
      await frozen.unroute('**/api/**');
      await frozen.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('online')));
      await expect(frozen.locator('.bn-editor')).toHaveCount(0, { timeout: 10000 });
      await expect
        .poll(
          async () =>
            (await records(frozen)).docs.filter(
              (d) => d.user === guestUser && d.workspace === workspace,
            ).length,
        )
        .toBe(0);
      await expect(frozen.getByRole('button', { name: 'Exporter le travail local' })).toBeVisible();
      assert(
        !JSON.stringify(await call(owner, `${base}/pages/${child.id}`, undefined, 'GET')).includes(
          'SOLE_OFFLINE_5C',
        ),
      );
      console.log(
        'PASS sole guest tab offline/frozen: first online check purges without an awake sibling, no replay',
      );
      await change('read');
      await open(frozen);
      await writer.getByRole('button', { name: 'Déplacer', exact: true }).click();
      await writer.getByLabel('Page parente').selectOption(elsewhere.id);
      await writer.getByRole('button', { name: 'Vérifier les accès', exact: true }).click();
      const preview = writer.getByRole('dialog', { name: 'Aperçu des accès' });
      await expect(preview).toContainText('Guest 5c');
      await expect(preview).toContainText('Lecture → Aucun accès');
      await writer.screenshot({ path: '.local/session-5c-preview.png', fullPage: true });
      await preview.getByRole('button', { name: 'Confirmer le déplacement' }).click();
      await expect(preview).toHaveCount(0);
      await expect(frozen.locator('.bn-editor')).toHaveCount(0, { timeout: 10000 });
      assert.equal((await guest.request.get(origin + `${base}/pages/${child.id}`)).status(), 404);
      assert.deepEqual(errors, []);
      console.log(
        'PASS share removal, restore of fresh read, preview then actual move changes inherited access; no browser errors',
      );
    } finally {
      await lifecycle.close();
      await browser.close();
      if (workspace) await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
      for (const a of accounts)
        await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [a.id, a.email]);
      await pool.end();
    }
  },
);
