import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { internalSignature } from '@memoria/auth/collaboration';
import { readCollabConfig } from '../service/config.ts';
import { createInternalServer } from '../service/internal-server.ts';
import { testDatabase } from './database.ts';
await test('Real internal HTTP: HMAC body/path/time and durable anti-replay', async () => {
  const db = await testDatabase(),
    secret = randomBytes(32).toString('hex');
  let executions = 0;
  const config = readCollabConfig({
    APP_ORIGIN: 'https://localhost',
    DATABASE_URL: db.url,
    BETTER_AUTH_SECRET: secret,
    COLLAB_INTERNAL_SECRET: secret,
    COLLAB_INTERNAL_PORT: '0',
  });
  const host = await createInternalServer(config, db.pool, async () => {
    executions++;
    return { ok: true };
  });
  try {
    const body = JSON.stringify({
      action: 'open',
      user: db.user,
      session: db.session,
      workspace: db.workspace,
      page: db.page,
    });
    const headers = internalSignature(secret, '/internal/collaboration', body);
    const call = (payload = body, signed = headers) =>
      fetch(host.url, { method: 'POST', headers: signed, body: payload });
    assert.equal((await call(body + ' ')).status, 401);
    assert.equal((await call(body, internalSignature(secret, '/wrong', body))).status, 401);
    assert.equal(
      (
        await call(
          body,
          internalSignature(secret, '/internal/collaboration', body, String(Date.now() - 60000)),
        )
      ).status,
      401,
    );
    assert.equal((await call()).status, 200);
    assert.equal((await call()).status, 401);
    assert.equal(executions, 1);
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS count FROM collaboration_nonces')).rows[0]
        .count,
      1,
    );
    console.log(
      'PASS HMAC: tampered body, wrong path, expired timestamp and replay rejected; one authenticated execution',
    );
  } finally {
    await host.close();
    await db.close();
  }
});
