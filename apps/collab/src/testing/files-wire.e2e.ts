import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID, randomBytes } from 'node:crypto';
import * as Y from 'yjs';
import { testDatabase } from './database.ts';
import { testAuth } from './auth.ts';
import { caddyFixture } from './caddy-fixture.ts';
import { securityPeer } from './security-peer.ts';
import { collaborationServer, sessionVerifier } from '../service/server.ts';
import { readCollabConfig } from '../service/config.ts';
import { emptyDocument, applyCommands } from '../service/commands.ts';
import { until } from './pool-helpers.ts';
import { internalSignature } from '@memoria/auth/collaboration';

test('7a R12 real Caddy WSS and HMAC: guessed file IDs never enter the journal', async (t) => {
  const db = await testDatabase(),
    authentication = await testAuth(db);
  const bad = await authentication.account('Unprivileged author'),
    good = await authentication.account('Innocent writer');
  const initial = emptyDocument(),
    snapshot = Y.encodeStateAsUpdate(initial),
    file = randomUUID();
  await db.pool.query(
    'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,100)',
    [db.page, db.workspace, db.generation, Buffer.from(snapshot), snapshot.length],
  );
  await db.pool.query(
    "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$1::uuid::text,'private fixture','application/octet-stream',12,'ready')",
    [file, db.workspace],
  );
  const config = readCollabConfig({
    ...process.env,
    DATABASE_URL: db.url,
    COLLAB_HOST: '0.0.0.0',
    COLLAB_PORT: '0',
    COLLAB_INTERNAL_PORT: '0',
    COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
  });
  const host = await collaborationServer(config, db.pool, sessionVerifier(authentication.auth));
  let proxy: Awaited<ReturnType<typeof caddyFixture>> | undefined;
  const peers: ReturnType<typeof securityPeer>[] = [];
  const operation = {
    op: 'insert' as const,
    id: randomUUID(),
    parentId: null,
    afterId: null,
    type: 'core.image',
    schemaVersion: 1,
    content: { fileId: file, alt: '', caption: '', width: 512 },
  };
  try {
    proxy = await caddyFixture(Number(new URL(host.ingress.url).port));
    const name = `${db.workspace}:${db.page}:${db.generation}`;
    const attacker = securityPeer(proxy.url, name, bad.cookie, authentication.origin, '', proxy.ca),
      innocent = securityPeer(proxy.url, name, good.cookie, authentication.origin, '', proxy.ca);
    peers.push(attacker, innocent);
    await until(() => attacker.provider.synced && innocent.provider.synced, 'sync');
    await t.test(
      'raw Yjs UUID without authorized source is rejected, innocent socket remains usable',
      async () => {
        const candidate = new Y.Doc();
        candidate.getXmlFragment('prosemirror');
        Y.applyUpdate(candidate, Y.encodeStateAsUpdate(attacker.doc));
        const vector = Y.encodeStateVector(candidate);
        applyCommands(candidate, [operation]);
        attacker.sendYjs(Y.encodeStateAsUpdate(candidate, vector));
        candidate.destroy();
        await until(() => attacker.closed, 'attacker rejected');
        assert.equal((await db.pool.query('SELECT * FROM file_usages')).rowCount, 0);
        assert.equal((await db.pool.query('SELECT * FROM collaboration_updates')).rowCount, 0);
        const text = [
          ...innocent.doc.getXmlFragment('prosemirror').createTreeWalker(() => true),
        ].find((n) => n instanceof Y.XmlText) as Y.XmlText;
        text.insert(0, 'still writing');
        await until(
          async () =>
            Number(
              (await db.pool.query('SELECT content_revision FROM collaboration_documents')).rows[0]
                .content_revision,
            ) > 0,
          'innocent durable',
        );
        assert.equal(innocent.closed, false);
      },
    );
    await t.test(
      'valid internal HMAC does not grant file access; errors contain no names or object keys',
      async () => {
        const revision = Number(
          (await db.pool.query('SELECT content_revision FROM collaboration_documents')).rows[0]
            .content_revision,
        );
        const body = JSON.stringify({
          action: 'write',
          user: bad.user,
          session: bad.session,
          workspace: db.workspace,
          page: db.page,
          generation: db.generation,
          expectedRevision: revision,
          receipt: randomUUID(),
          operations: [{ ...operation, id: randomUUID() }],
        });
        const url = new URL(host.internal.url);
        const r = await fetch(host.internal.url, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            ...internalSignature(config.COLLAB_INTERNAL_SECRET, url.pathname, body),
          },
          body,
        });
        assert.ok(r.status >= 400);
        const text = await r.text();
        assert.equal(text.includes('private fixture'), false);
        assert.equal(text.includes('staging/'), false);
        assert.equal((await db.pool.query('SELECT * FROM file_usages')).rowCount, 0);
        assert.equal(
          Number(
            (await db.pool.query('SELECT content_revision FROM collaboration_documents')).rows[0]
              .content_revision,
          ),
          revision,
        );
      },
    );
  } finally {
    for (const peer of peers) peer.destroy();
    proxy?.close();
    await host.close();
    await authentication.pool.end();
    initial.destroy();
    await db.close();
  }
});
