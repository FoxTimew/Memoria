import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import { createRequire } from 'node:module';
import { chromium, expect } from '@playwright/test';
import { lifecycleBrowser } from './browser-lifecycle.mjs';
import { writeFile } from 'node:fs/promises';
import { performance } from 'node:perf_hooks';
import { prepareMeasurement, runMeasuredSeries } from './measurement-memory.mjs';

const refreshTrace = process.argv.includes('--refresh-trace');
const preparation = refreshTrace ? await prepareMeasurement('database-refresh-oracle') : undefined;

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
  '6c final UI: typed table, guest task, CAS, selectors, native rows and cache resurrection attacks',
  { timeout: 480000 },
  async () => {
    const browser = await chromium.launch({
      channel:
        process.env.BROWSER_CHANNEL ?? (process.platform === 'win32' ? 'msedge' : 'chromium'),
      headless: true,
    });
    const lifecycle = await lifecycleBrowser(),
      accounts = [],
      errors = [];
    const quotaTrace = [];
    const quotaDetails = [];
    let workspace;
    try {
      const owner = await browser.newContext({ viewport: { width: 1440, height: 1100 } }),
        guest = lifecycle.context;
      if (!refreshTrace)
        for (const [role, context] of [
          ['owner', owner],
          ['guest', guest],
        ]) {
          context.on('response', (response) => {
            const url = new URL(response.url());
            if (!url.pathname.startsWith('/api/')) return;
            const observation = {
              role,
              at: Date.now(),
              path: url.pathname.replace(/[0-9a-f]{8}-[0-9a-f-]{27}/gi, ':id'),
              method: response.request().method(),
              status: response.status(),
            };
            quotaTrace.push(observation);
            if (response.status() === 429)
              quotaDetails.push(
                (async () => {
                  const body = await response.json().catch(() => ({}));
                  observation.code = body.code;
                  observation.retryAfter = response.headers()['retry-after'];
                })(),
              );
          });
        }
      const password = randomBytes(24).toString('base64url');
      async function account(context, name) {
        const email = `table6c-${randomUUID()}@example.test`;
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
      await account(owner, 'Owner 6c');
      const guestUser = await account(guest, 'Guest 6c');
      workspace = (
        await call(
          owner,
          '/api/internal/workspaces',
          { name: 'Table 6c', slug: 'table6c-' + randomUUID() },
          'POST',
          201,
        )
      ).id;
      const root = `/api/internal/workspaces/${workspace}`,
        member = randomUUID();
      await pool.query(
        "INSERT INTO workspace_members(id,user_id,workspace_id,role) VALUES($1,$2,$3,'guest')",
        [member, guestUser, workspace],
      );
      await pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
        workspace,
        guestUser,
      ]);
      const main = await call(owner, root + '/databases', { title: 'Tâches 6c' }),
        secret = await call(owner, root + '/databases', { title: 'SECRET BASE' }),
        other = await call(owner, root + '/databases', { title: 'Autre base' });
      const endpoint = root + '/databases/' + main.id,
        href = `${origin}/workspaces/${workspace}/databases/${main.id}`;
      async function schema() {
        return call(owner, endpoint, undefined, 'GET');
      }
      const properties = {},
        options = {};
      for (const [kind, name] of Object.entries({
        text: 'Notes',
        number: 'Charge',
        select: 'Statut',
        multi_select: 'Étiquettes',
        date: 'Échéance',
        checkbox: 'Vérifié',
        person: 'Responsables',
        relation: 'Dépendances',
        url: 'Lien',
      })) {
        properties[kind] = (
          await call(owner, endpoint + '/properties', {
            expectedSchemaVersion: (await schema()).schema_version,
            kind,
            name,
            ...(kind === 'relation' ? { targetDatabaseId: secret.id } : {}),
          })
        ).id;
      }
      for (const kind of ['select', 'multi_select'])
        for (const label of kind === 'select' ? ['À faire', 'Terminé'] : ['Art', 'Son'])
          options[label] = (
            await call(owner, `${endpoint}/properties/${properties[kind]}/options`, {
              expectedSchemaVersion: (await schema()).schema_version,
              label,
            })
          ).id;
      const row = (
        await call(owner, endpoint + '/rows', {
          receipt: randomUUID(),
          expectedSchemaVersion: (await schema()).schema_version,
          title: 'Livrer le décor',
        })
      ).id;
      const secretRow = (
        await call(owner, `${root}/databases/${secret.id}/rows`, {
          receipt: randomUUID(),
          expectedSchemaVersion: '1',
          title: 'SECRET ROW',
        })
      ).id;
      const otherRow = (
        await call(owner, `${root}/databases/${other.id}/rows`, {
          receipt: randomUUID(),
          expectedSchemaVersion: '1',
          title: 'Indépendante',
        })
      ).id;
      async function write(kind, value) {
        const path = `${endpoint}/rows/${row}/cells/${properties[kind]}`,
          c = await call(owner, path, undefined, 'GET');
        return call(
          owner,
          path,
          { expectedSchemaVersion: c.schemaVersion, expectedCellVersion: c.version, value },
          'PATCH',
        );
      }
      await write('relation', { add: [secretRow] });
      const people = await call(owner, `${endpoint}/properties/${properties.person}/choices`, {});
      await write('person', { add: [people.items.find((p) => p.name === 'Owner 6c').id] });
      const management = await owner.newPage();
      management.on('pageerror', (e) => errors.push(e.message));
      await virtualKey(management);
      await management.goto(`${origin}/workspaces/${workspace}/acces`);
      await management.getByLabel('Page à partager').selectOption(main.pageId);
      await management.getByLabel('Partage direct pour Guest 6c').selectOption('read');
      await management
        .getByRole('button', { name: 'Enregistrer le partage pour Guest 6c' })
        .click();
      await management.getByRole('link', { name: 'Configurer ou vérifier mon identité' }).click();
      await enrollAndProve(management);
      async function share(base, level) {
        const s = await call(owner, `${root}/pages/${base.pageId}/shares`, undefined, 'GET');
        await call(
          owner,
          `${root}/pages/${base.pageId}/shares/${member}`,
          { expectedAccessVersion: s.accessVersion, level },
          'PUT',
        );
      }
      await share(main, 'read');
      await share(other, 'edit');
      let reader = await lifecycle.page();
      const writer = await owner.newPage();
      if (refreshTrace) {
        await management.close();
        await reader.close();
        const rowTab = await owner.newPage();
        await writer.goto(href);
        await rowTab.goto(`${href}/rows/${row}`);
        await expect(writer.locator('tbody tr')).toHaveCount(1);
        await expect(rowTab.getByTestId('local-save-status')).toHaveText('Copie locale à jour', {
          timeout: 20000,
        });
        assert.equal(await writer.evaluate(() => globalThis.document.hidden), false);
        assert.equal(await rowTab.evaluate(() => globalThis.document.hidden), false);
        const requests = [];
        const { result, hygiene } = await runMeasuredSeries(
          'database-refresh-oracle',
          async () => {
            const start = performance.now();
            const listeners = [writer, rowTab].map((page, tab) => {
              const record = (response) => {
                const path = new URL(response.url()).pathname;
                if (path.startsWith('/api/'))
                  requests.push({
                    tab: tab ? 'row' : 'table',
                    elapsedMs: performance.now() - start,
                    path: path
                      .replaceAll(workspace, ':workspace')
                      .replaceAll(main.id, ':database')
                      .replaceAll(row, ':row'),
                    method: response.request().method(),
                    status: response.status(),
                  });
              };
              page.on('response', record);
              return () => page.off('response', record);
            });
            try {
              await new Promise((resolve) => globalThis.setTimeout(resolve, 65000));
            } finally {
              for (const stop of listeners) stop();
            }
            return { durationMs: performance.now() - start, requests };
          },
          { preparation },
        );
        const report = {
          purpose:
            'Wire cadence oracle, two real visible final UI tabs; not a latency qualification',
          source: '6c final application',
          preparation,
          hygiene,
          ...result,
        };
        await writeFile(
          '.local/session-6d-refresh-oracle.json',
          JSON.stringify(report, null, 2) + '\n',
        );
        assert(
          requests.every((r) => r.status === 200),
          'Refresh oracle received non-200 response; stop before changing quotas/cadence',
        );
        console.log(
          'PASS final UI cadence oracle: two visible tabs, 65 seconds, ' +
            requests.length +
            ' API responses',
        );
        return;
      }
      for (const page of [reader, writer]) page.on('pageerror', (e) => errors.push(e.message));
      await reader.goto(href);
      await expect(reader.getByText('Lecture seule : cette base')).toBeVisible();
      await expect(reader.getByRole('button', { name: /Modifier Statut/ })).toHaveCount(0);
      await expect(reader.getByRole('button', { name: 'Gérer les colonnes' })).toHaveCount(0);
      await expect(
        reader.getByText('Certaines valeurs ne sont pas accessibles', { exact: true }),
      ).toHaveCount(2);
      assert(!(await reader.locator('main').innerText()).includes('SECRET'));
      // Attack from the loaded final UI: hiding controls cannot be the authorization boundary.
      const attackErrors = [];
      async function hostile(path, method = 'GET', body) {
        const response = await reader.evaluate(
          async ({ path, method, body }) => {
            const r = await globalThis.fetch(path, {
              method,
              headers: { 'content-type': 'application/json' },
              ...(body === undefined ? {} : { body: JSON.stringify(body) }),
            });
            return { status: r.status, data: await r.json() };
          },
          { path, method, body },
        );
        if (response.status >= 400) attackErrors.push(response.data);
        return response;
      }
      async function hostileCell(kind, value, status) {
        const path = `${endpoint}/rows/${row}/cells/${properties[kind]}`;
        const current = await call(owner, path, undefined, 'GET');
        assert.equal(
          (
            await hostile(path, 'PATCH', {
              expectedSchemaVersion: current.schemaVersion,
              expectedCellVersion: current.version,
              value,
            })
          ).status,
          status,
        );
      }
      await hostileCell('text', 'FORGED READ ONLY WRITE', 404);
      assert.equal(
        (await call(owner, `${endpoint}/rows/${row}/cells/${properties.text}`, undefined, 'GET'))
          .value,
        null,
      );
      const secretPath = `${root}/databases/${secret.id}/rows/${secretRow}`;
      assert.deepEqual(
        await hostile(secretPath),
        await hostile(`${root}/databases/${randomUUID()}/rows/${randomUUID()}`),
      );
      console.log(
        'PASS 6d final UI attacks: forged read-only write and hidden native row denied, hidden/missing replies identical',
      );
      console.log(
        'PASS guest read: immutable table, hidden schema, neutral relation/person without title/id/count',
      );
      await share(main, 'edit');
      await reader.reload();
      await writer.goto(href);
      assert.equal(
        (
          await hostile(endpoint + '/properties', 'POST', {
            expectedSchemaVersion: (await schema()).schema_version,
            kind: 'text',
            name: 'FORGED SCHEMA',
          })
        ).status,
        404,
      );
      await hostileCell('relation', { remove: [secretRow] }, 400);
      await hostileCell('url', 'javascript:globalThis.__databaseAttack=1', 400);
      assert.equal(
        (
          await call(
            owner,
            `${endpoint}/rows/${row}/cells/${properties.relation}`,
            undefined,
            'GET',
          )
        ).value.items[0].id,
        secretRow,
      );
      const injection = '<img src=x onerror="globalThis.__databaseAttack=1">';
      await write('text', injection);
      await reader.reload();
      await expect(
        reader.getByRole('button', { name: 'Modifier Notes de Livrer le décor' }),
      ).toHaveText(injection);
      assert.equal(await reader.locator('tbody img').count(), 0);
      assert.equal(await reader.evaluate(() => globalThis.__databaseAttack), undefined);
      await write('text', null);
      await reader.reload();
      console.log(
        'PASS 6d final UI attacks: forged guest schema, hidden relation removal and javascript URL denied; HTML text stays inert',
      );
      async function edit(page, label) {
        await page
          .getByRole('button', { name: `Modifier ${label} de Livrer le décor`, exact: true })
          .click();
        await expect(page.getByRole('dialog')).toBeVisible();
        return page.getByRole('dialog');
      }
      async function save(page) {
        await page.getByRole('button', { name: 'Enregistrer la cellule', exact: true }).click();
        await expect(page.getByRole('dialog')).toHaveCount(0);
      }
      let d = await edit(reader, 'Statut');
      await d.getByLabel('Terminé', { exact: true }).check();
      await save(reader);
      await expect(
        reader.getByRole('button', { name: 'Modifier Statut de Livrer le décor' }),
      ).toHaveText('Terminé');
      assert.equal(
        (await call(owner, `${endpoint}/rows/${row}/cells/${properties.select}`, undefined, 'GET'))
          .value,
        options['Terminé'],
      );
      console.log('PASS original use case: guest editor updates task status through final UI');
      d = await edit(reader, 'Responsables');
      await expect(d.getByRole('group')).toHaveCount(0);
      await expect(d.getByLabel('Guest 6c', { exact: true })).toBeVisible();
      await expect(d.getByLabel('Owner 6c', { exact: true })).toHaveCount(0);
      await d.getByLabel('Guest 6c', { exact: true }).check();
      await save(reader);
      assert.equal(
        (await call(owner, `${endpoint}/rows/${row}/cells/${properties.person}`, undefined, 'GET'))
          .value.items.length,
        2,
        'hidden assignment preserved',
      );
      d = await edit(reader, 'Dépendances');
      await expect(d.getByText('Aucune valeur disponible.')).toBeVisible();
      await save(reader);
      assert.equal(
        (
          await call(
            owner,
            `${endpoint}/rows/${row}/cells/${properties.relation}`,
            undefined,
            'GET',
          )
        ).value.items[0].id,
        secretRow,
      );
      d = await edit(reader, 'Notes');
      await d.getByLabel('Valeur', { exact: true }).fill('Ma saisie conservée');
      await write('text', 'Valeur du collègue');
      await d.getByRole('button', { name: 'Enregistrer la cellule' }).click();
      await expect(d.getByText('Valeur actuelle : Valeur du collègue.')).toBeVisible();
      await expect(d.getByLabel('Valeur', { exact: true })).toHaveValue('Ma saisie conservée');
      await d.getByRole('button', { name: 'Garder ma saisie pour la réappliquer' }).click();
      await save(reader);
      assert.equal(
        (await call(owner, `${endpoint}/rows/${row}/cells/${properties.text}`, undefined, 'GET'))
          .value,
        'Ma saisie conservée',
      );
      console.log(
        'PASS cell conflict shows current value, preserves input, explicit reapply; hidden references retained',
      );
      for (const [label, value] of [
        ['Charge', '0'],
        ['Lien', 'https://example.test/task'],
      ]) {
        d = await edit(reader, label);
        await d.getByLabel('Valeur', { exact: true }).fill(value);
        await save(reader);
      }
      d = await edit(reader, 'Vérifié');
      await d.getByLabel('Valeur', { exact: true }).selectOption('false');
      await save(reader);
      d = await edit(reader, 'Échéance');
      await d.getByLabel('Début', { exact: true }).fill('2026-10-27');
      await d.getByLabel('Fin (facultative)').fill('2026-10-28');
      await save(reader);
      d = await edit(reader, 'Étiquettes');
      await d.getByLabel('Art', { exact: true }).check();
      await d.getByLabel('Son', { exact: true }).check();
      await save(reader);
      await reader.getByRole('button', { name: 'Tri et filtres', exact: true }).click();
      await reader.getByRole('button', { name: 'Ajouter un filtre' }).click();
      await reader.getByLabel('Valeur du filtre 1').fill('Livrer');
      await reader.getByRole('button', { name: 'Ajouter un tri' }).click();
      await reader.getByLabel('Sens du tri 1').selectOption('desc');
      await reader.getByRole('button', { name: 'Appliquer à mon affichage' }).click();
      await expect(
        reader.getByRole('link', { name: 'Livrer le décor', exact: true }),
      ).toBeVisible();
      await writer.getByRole('button', { name: 'Gérer les colonnes' }).click();
      await writer.getByLabel('Nom de la propriété', { exact: true }).fill('Contrôle UI');
      await writer.getByRole('button', { name: 'Créer la propriété' }).click();
      await expect(writer.getByRole('columnheader', { name: 'Contrôle UI' })).toBeVisible();
      console.log(
        'PASS nine cell editors, filters/sort and schema creation visible only to authorized role',
      );
      // Pagination goes through signed cursors; only fixture rows are created by HTTP.
      const pageSchema = (await schema()).schema_version;
      for (let i = 0; i < 10; i++)
        await call(owner, endpoint + '/rows', {
          receipt: randomUUID(),
          expectedSchemaVersion: pageSchema,
          title: `Pagination ${i}`,
        });
      await writer.reload();
      await writer.getByLabel('Lignes par page').selectOption('10');
      await expect(writer.locator('tbody tr')).toHaveCount(10);
      const firstIds = await writer
        .locator('tbody tr')
        .evaluateAll((rows) => rows.map((r) => r.getAttribute('data-row-id')));
      await writer.getByRole('button', { name: 'Page suivante', exact: true }).click();
      await expect(writer.locator('tbody tr')).toHaveCount(1);
      assert(!firstIds.includes(await writer.locator('tbody tr').getAttribute('data-row-id')));
      await writer.getByRole('button', { name: 'Page précédente', exact: true }).click();
      await expect(writer.locator('tbody tr')).toHaveCount(10);
      await writer.screenshot({ path: '.local/session-6c-table.png', fullPage: true });
      console.log(
        'PASS final UI signed cursor pagination: no repeated rows and return to previous page',
      );
      await reader.goto(`${href}/rows/${row}`);
      const editor = (p) => p.locator('.bn-editor');
      async function ready(p) {
        await expect(editor(p)).toBeVisible({ timeout: 20000 });
        await expect(p.getByTestId('local-save-status')).toHaveText('Copie locale à jour', {
          timeout: 15000,
        });
      }
      await ready(reader);
      await writer.goto(`${href}/rows/${row}`);
      await ready(writer);
      await editor(reader).press('End');
      await editor(reader).pressSequentially('CORPS 6C');
      await expect(editor(writer)).toContainText('CORPS 6C', { timeout: 15000 });
      await reader
        .getByRole('textbox', { name: 'Titre de la page', exact: true })
        .fill('Livraison finale');
      await reader.getByRole('button', { name: 'Enregistrer le titre', exact: true }).click();
      await expect
        .poll(async () => (await call(owner, `${endpoint}/rows/${row}`, undefined, 'GET')).title)
        .toBe('Livraison finale');
      await expect(reader.getByTestId('save-status')).toHaveText('Enregistré sur le serveur');
      console.log(
        'PASS native row WSS collaboration between two browsers, relational title and local Yjs cache',
      );
      // Explicit think time between the interaction and revocation phases, approved for 6d.
      // Keep the real background timers running; never reset a bucket or retry a 429.
      console.log(
        'PACING: 65 seconds before cache attacks, unchanged production quotas and refresh timers',
      );
      await new Promise((resolve) => globalThis.setTimeout(resolve, 65000));
      await guest.setOffline(true);
      await reader.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('offline')));
      await editor(reader).press('End');
      await editor(reader).pressSequentially(' OFFLINE RETAINED');
      await expect(reader.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      await reader.close();
      await guest.setOffline(false);
      reader = await lifecycle.page();
      reader.on('pageerror', (e) => errors.push(e.message));
      await reader.goto(`${href}/rows/${row}`);
      await ready(reader);
      await expect(editor(writer)).toContainText('OFFLINE RETAINED', { timeout: 15000 });
      console.log(
        'PASS final UI offline edit survives closing/reopening a row tab and merges after access recheck',
      );
      const independent = await lifecycle.page();
      await independent.goto(
        `${origin}/workspaces/${workspace}/databases/${other.id}/rows/${otherRow}`,
      );
      await ready(independent);
      const independentKeys = (await records(independent)).docs
        .filter((x) => x.page === otherRow)
        .map((x) => x.key);
      assert(independentKeys.length);
      // Only the guest context is offline; the owner performs the actual HTTP revocation.
      await guest.setOffline(true);
      await reader.evaluate(() => globalThis.dispatchEvent(new globalThis.Event('offline')));
      await editor(reader).press('End');
      await editor(reader).pressSequentially(' FORBIDDEN REPLAY');
      await expect(reader.getByTestId('local-save-status')).toHaveText('Copie locale à jour');
      const resume = await lifecycle.freeze(reader);
      await share(main, null);
      await guest.setOffline(false);
      await expect
        .poll(async () => (await records(independent)).docs.filter((x) => x.page === row).length, {
          timeout: 20000,
        })
        .toBe(0);
      assert.deepEqual(
        (await records(independent)).docs.filter((x) => x.page === otherRow).map((x) => x.key),
        independentKeys,
        'other base is retained',
      );
      await resume();
      await expect(
        reader.getByText('Votre accès à cette base ou à cette ligne a changé.'),
      ).toBeVisible({ timeout: 15000 });
      await share(main, 'read');
      await reader.reload();
      await ready(reader);
      await expect(editor(reader)).toHaveAttribute('contenteditable', 'false');
      await expect(editor(reader)).not.toContainText('FORBIDDEN REPLAY');
      await expect(
        reader.getByRole('textbox', { name: 'Titre de la page', exact: true }),
      ).toBeDisabled();
      assert(!(await editor(writer).innerText()).includes('FORBIDDEN REPLAY'));
      console.log(
        'PASS final UI frozen/offline old ticket cannot resurrect after removal/regrant; unrelated base survives; read-only body receives fresh document',
      );
      // Archive/restoration also changes the lifecycle even with identical base rights.
      const old = await call(owner, `${endpoint}/rows/${row}`, undefined, 'GET');
      await call(owner, `${endpoint}/rows/${row}/archive`, { expectedVersion: old.version });
      await expect
        .poll(async () => (await records(independent)).docs.filter((x) => x.page === row).length, {
          timeout: 20000,
        })
        .toBe(0);
      const archived = await call(owner, endpoint + '/trash', undefined, 'GET');
      await call(owner, `${endpoint}/rows/${row}/restore`, {
        expectedVersion: archived.items.find((r) => r.id === row).version,
      });
      await reader.reload();
      await ready(reader);
      const frozenPolicy = await lifecycle.freeze(reader);
      let policy = await call(owner, root + '/security', undefined, 'GET');
      await call(
        owner,
        root + '/security',
        { expectedVersion: policy.version, allowPersistentCache: false },
        'PUT',
      );
      await expect
        .poll(
          async () => (await records(independent)).docs.filter((x) => x.user === guestUser).length,
          { timeout: 20000 },
        )
        .toBe(0);
      await frozenPolicy();
      await expect(reader.getByTestId('local-save-status')).toHaveText(
        'Copie locale désactivée sur cet appareil ou dans cet espace',
        { timeout: 15000 },
      );
      await reader.reload();
      await expect(editor(reader)).toBeVisible({ timeout: 15000 });
      assert.equal((await records(reader)).docs.filter((x) => x.user === guestUser).length, 0);
      policy = await call(owner, root + '/security', undefined, 'GET');
      await call(
        owner,
        root + '/security',
        { expectedVersion: policy.version, allowPersistentCache: true },
        'PUT',
      );
      await reader.reload();
      await ready(reader);
      assert((await records(reader)).docs.some((x) => x.user === guestUser));
      console.log(
        'PASS 6d final UI: workspace cache prohibition purges rows and fences a frozen tab/reload; fresh authorization can create a new cache',
      );
      const frozenLogout = await lifecycle.freeze(reader);
      await independent.goto(origin);
      await independent.getByRole('button', { name: 'Se déconnecter', exact: true }).click();
      await independent
        .getByRole('button', { name: 'Effacer les copies locales et se déconnecter', exact: true })
        .click();
      await expect(independent).toHaveURL(/\/connexion/);
      await frozenLogout();
      await expect
        .poll(
          async () => (await records(independent)).docs.filter((x) => x.user === guestUser).length,
        )
        .toBe(0);
      await expect(reader.locator('main')).toContainText('Session fermée');
      console.log(
        'PASS archive/restore lifecycle and logout fence frozen row UI, cache remains empty',
      );
      const metadata = await pool.query(
        'SELECT metadata::text AS value FROM audit_logs WHERE workspace_id=$1 UNION ALL SELECT payload::text FROM outbox_events WHERE workspace_id=$1',
        [workspace],
      );
      const sinks = JSON.stringify({ errors, attackErrors, metadata: metadata.rows });
      for (const canary of [
        password,
        injection,
        'Ma saisie conservée',
        'FORBIDDEN REPLAY',
        ...accounts.map((a) => a.email),
      ])
        assert(!sinks.includes(canary), 'Canary appeared in error/audit/outbox sink');
      console.log(
        'PASS 6d canaries absent from browser errors, denial bodies and workspace audit/outbox metadata; functional document responses excluded',
      );
      assert.deepEqual(errors, []);
      assert(
        !quotaTrace.some((r) => r.status === 429),
        'Unexpected quota failure in paced UI attacks',
      );
    } finally {
      await Promise.allSettled(quotaDetails);
      if (!refreshTrace)
        await writeFile(
          '.local/session-6d-browser-requests.json',
          JSON.stringify(quotaTrace, null, 2) + '\n',
        );
      await lifecycle.close();
      await browser.close();
      if (workspace) await pool.query('DELETE FROM workspaces WHERE id=$1', [workspace]);
      for (const a of accounts)
        await pool.query('DELETE FROM auth_users WHERE id=$1 AND email=$2', [a.id, a.email]);
      await pool.end();
    }
  },
);
