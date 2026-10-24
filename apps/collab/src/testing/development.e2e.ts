import assert from 'node:assert/strict';
import { test } from 'node:test';
import { randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { testDatabase } from './database.ts';

test('Development commands: scoped reset, dry run, leader exclusion and verified membership', async () => {
  const db = await testDatabase();
  const run = (args: string[], env = {}) =>
    spawnSync(
      process.execPath,
      ['scripts/dev-collaboration.mjs', ...args, '--workspace', db.workspace],
      {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 10000,
        env: { ...process.env, DATABASE_URL: db.url, ...env },
      },
    );
  const count = async (table: 'blocks' | 'workspace_members' | 'actors') =>
    (await db.pool.query(`SELECT count(*)::int AS n FROM ${table}`)).rows[0].n;
  try {
    const otherWorkspace = randomUUID(),
      otherPage = randomUUID(),
      yjsPage = randomUUID();
    await db.pool.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Other',$2)", [
      otherWorkspace,
      otherWorkspace,
    ]);
    await db.pool.query(
      "INSERT INTO pages(id,workspace_id,position,title) VALUES($1,$2,'a1','Yjs'),($3,$4,'a0','Other')",
      [yjsPage, db.workspace, otherPage, otherWorkspace],
    );
    await db.pool.query("UPDATE pages SET title='Retained title' WHERE id=$1", [db.page]);
    for (const [page, workspace] of [
      [db.page, db.workspace],
      [yjsPage, db.workspace],
      [otherPage, otherWorkspace],
    ]) {
      await db.pool.query(
        "INSERT INTO blocks(id,workspace_id,page_id,position,type,schema_version,content) VALUES($1,$2,$3,'a0','core.paragraph',1,'{}')",
        [randomUUID(), workspace, page],
      );
    }
    await db.pool.query(
      'INSERT INTO collaboration_documents(workspace_id,page_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,2,2)',
      [db.workspace, yjsPage, randomUUID(), Buffer.from([0, 0])],
    );
    const dry = run(['reset-legacy']);
    assert.equal(dry.status, 0, dry.stderr);
    assert.deepEqual(JSON.parse(dry.stdout).legacyPages, [db.page]);
    assert.equal(await count('blocks'), 3);
    assert.notEqual(run(['reset-legacy', '--apply', '--confirm', randomUUID()]).status, 0);
    assert.equal(await count('blocks'), 3);
    await db.client.query('SELECT pg_advisory_lock($1,hashtext(current_schema()))', [1296387393]);
    try {
      const locked = run(['reset-legacy', '--apply', '--confirm', db.workspace]);
      assert.notEqual(locked.status, 0);
      assert.match(locked.stderr, /Stop apps\/collab/);
    } finally {
      await db.client.query(
        'SELECT pg_advisory_unlock($1,hashtext(current_schema()))',
        [1296387393],
      );
    }
    const applied = run(['reset-legacy', '--apply', '--confirm', db.workspace]);
    assert.equal(applied.status, 0, applied.stderr);
    assert.equal(await count('blocks'), 2);
    const page = (await db.pool.query('SELECT title,version FROM pages WHERE id=$1', [db.page]))
      .rows[0];
    assert.deepEqual(page, { title: 'Retained title', version: '2' });
    assert.equal(
      (await db.pool.query('SELECT plain_text FROM search_documents WHERE page_id=$1', [db.page]))
        .rows[0].plain_text,
      'Retained title',
    );
    assert.equal(
      (await db.pool.query('SELECT count(*)::int AS n FROM collaboration_documents')).rows[0].n,
      1,
    );
    assert.equal(run(['reset-legacy', '--apply', '--confirm', db.workspace]).status, 0);

    const email = `${randomUUID()}@example.test`,
      user = randomUUID();
    await db.pool.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Second',$2,false)",
      [user, email],
    );
    assert.notEqual(run(['add-member', '--email', email]).status, 0);
    assert.equal(await count('workspace_members'), 1);
    await db.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [user]);
    const added = run(['add-member', '--email', email]);
    assert.equal(added.status, 0, added.stderr);
    assert.equal(run(['add-member', '--email', email]).status, 0);
    assert.equal(await count('workspace_members'), 2);
    assert.equal(await count('actors'), 2);
    assert.equal(
      (await db.pool.query('SELECT role FROM workspace_members WHERE user_id=$1', [user])).rows[0]
        .role,
      'member',
    );
    assert.notEqual(run(['reset-legacy'], { NODE_ENV: 'production' }).status, 0);
    console.log(
      'PASS scoped reset preserves Yjs and other workspace; preview, confirmation, leader guard, idempotence, verified member and production refusal',
    );
  } finally {
    await db.close();
  }
});
