import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import pg from 'pg';
import { testDatabase } from './database.ts';
import { Leadership } from '../service/leadership.ts';
import { Store } from '../service/store.ts';
import { Room } from '../service/room.ts';
import { Projections } from '../service/projection.ts';
import { decodeDocument } from '../codec.ts';
test('Journal rollback, replay receipt and file projection against real SQL', async () => {
  const db = await testDatabase(),
    leader = new Leadership(db.url, () => {});
  await leader.start();
  const store = new Store(db.pool, leader),
    identity = { ...db, key: db.user },
    state = await store.open(identity),
    doc = new Y.Doc(),
    room = new Room(store, db.page, state.generation, doc, () => {}),
    projection = new Projections(store);
  try {
    await room.load();
    const source = new Y.Doc();
    source.getXmlFragment('prosemirror');
    Y.applyUpdate(source, Y.encodeStateAsUpdate(doc));
    let update!: Uint8Array;
    source.on('update', (u: Uint8Array) => {
      update = u;
    });
    const content = (
      (source.getXmlFragment('prosemirror').get(0) as Y.XmlElement).get(0) as Y.XmlElement
    ).get(0) as Y.XmlElement;
    const text = content.get(0) as Y.XmlText;
    text.insert(0, 'durable');
    const before = decodeDocument(doc);
    await db.pool.query(
      `CREATE FUNCTION test_journal_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'journal failure'; END $$; CREATE TRIGGER test_journal_failure BEFORE INSERT ON collaboration_updates FOR EACH ROW EXECUTE FUNCTION test_journal_failure()`,
    );
    await assert.rejects(room.update(identity, update), /journal failure/);
    assert.deepEqual(decodeDocument(doc), before);
    assert.equal(room.revision, 1);
    assert.equal(
      Number((await db.pool.query('SELECT count(*) FROM collaboration_receipts')).rows[0].count),
      0,
    );
    await db.pool.query(
      'DROP TRIGGER test_journal_failure ON collaboration_updates; DROP FUNCTION test_journal_failure()',
    );
    const receipt = await room.update(identity, update);
    const loadedDoc = new Y.Doc(),
      loadedRoom = new Room(store, db.page, state.generation, loadedDoc, () => {});
    try {
      await loadedRoom.load();
      assert.deepEqual(decodeDocument(loadedDoc), decodeDocument(doc));
      assert.deepEqual(await loadedRoom.replica.inspect(), decodeDocument(doc));
      assert.equal(loadedRoom.revision, receipt.revision);
    } finally {
      await loadedRoom.close();
      loadedDoc.destroy();
    }
    await projection.project(db.page, state.generation);
    const retry = await room.update(identity, update);
    assert.equal(retry.revision, receipt.revision);
    assert.equal(room.revision, receipt.revision);
    assert.equal(
      Number((await db.pool.query('SELECT count(*) FROM collaboration_updates')).rows[0].count),
      0,
    );
    const file = randomUUID(),
      block = randomUUID();
    await db.pool.query(
      "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$1::uuid::text,'image.png','image/png',12,'ready')",
      [file, db.workspace],
    );
    await db.pool.query(
      `INSERT INTO file_upload_intents(file_id,workspace_id,user_id,page_id,idempotency_key,requested_bytes,reserved_bytes,request_hash,expires_at,absolute_expires_at,attach_until) VALUES($1,$2,$3,$4,$1,12,12,'fixture',now()+interval '1 day',now()+interval '7 days',now()+interval '1 day')`,
      [file, db.workspace, db.user, db.page],
    );
    const written = await room.command(identity, {
      action: 'write',
      user: db.user,
      session: db.session,
      workspace: db.workspace,
      page: db.page,
      generation: state.generation,
      expectedRevision: room.revision,
      receipt: randomUUID(),
      operations: [
        {
          op: 'insert',
          id: block,
          parentId: null,
          afterId: null,
          type: 'core.image',
          schemaVersion: 1,
          content: { fileId: file, alt: 'Map', caption: '', width: 512 },
        },
      ],
    });
    await projection.project(db.page, state.generation);
    assert.equal(
      (await db.pool.query('SELECT file_id FROM file_references WHERE block_id=$1', [block]))
        .rows[0].file_id,
      file,
    );
    assert.equal(
      Number(
        (
          await db.pool.query(
            'SELECT projection_revision FROM collaboration_documents WHERE page_id=$1',
            [db.page],
          )
        ).rows[0].projection_revision,
      ),
      written.revision,
    );
    source.destroy();
  } finally {
    await projection.close();
    await room.close();
    doc.destroy();
    await leader.close();
    await db.close();
  }
});

test('Prepared journal keeps concurrent block ownership, page revisions and fresh permissions', async () => {
  const db = await testDatabase(),
    leader = new Leadership(db.url, () => {});
  await leader.start();
  const store = new Store(db.pool, leader),
    second = randomUUID(),
    sharedBlock = randomUUID();
  try {
    await db.pool.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'b0')", [
      second,
      db.workspace,
    ]);
    const identities = [db.page, second].map((page) => ({ ...db, page, key: randomUUID() }));
    const states = await Promise.all(identities.map((identity) => store.open(identity)));
    const append = (index: number, revision: number, ids: string[]) =>
      store.append(
        states[index]!.generation,
        revision,
        [{ identity: identities[index]!, receipt: randomUUID(), update: new Uint8Array([0, 0]) }],
        new Uint8Array([0, 0]),
        [],
        ids,
      );
    const results = await Promise.allSettled([
      append(0, 1, [sharedBlock]),
      append(1, 1, [sharedBlock]),
    ]);
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    const rejected = results.find((r) => r.status === 'rejected') as PromiseRejectedResult;
    assert.match(rejected.reason.message, /BLOCK_ID_CONFLICT/);
    assert.equal(
      Number((await db.pool.query('SELECT count(*) FROM collaboration_receipts')).rows[0].count),
      1,
    );
    assert.equal(
      Number((await db.pool.query('SELECT count(*) FROM collaboration_updates')).rows[0].count),
      1,
    );
    const winner = results.findIndex((r) => r.status === 'fulfilled');
    assert.equal(
      (
        await db.pool.query('SELECT page_id FROM collaboration_block_ids WHERE id=$1', [
          sharedBlock,
        ])
      ).rows[0].page_id,
      identities[winner]!.page,
    );
    const race = await Promise.allSettled([
      append(winner, 2, [sharedBlock]),
      append(winner, 2, [sharedBlock]),
    ]);
    assert.equal(race.filter((r) => r.status === 'fulfilled').length, 1);
    assert.match(
      (race.find((r) => r.status === 'rejected') as PromiseRejectedResult).reason.message,
      /REVISION_CHANGED/,
    );
    // Warm the prepared statement, then revoke: only its query plan may be reused, never rights.
    for (let i = 0; i < 8; i++) await store.authorize(identities[winner]!);
    await db.pool.query('DELETE FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
      db.workspace,
      db.user,
    ]);
    await assert.rejects(append(winner, 3, [sharedBlock]), /ACCESS_DENIED/);
    assert.equal(
      Number((await db.pool.query('SELECT count(*) FROM collaboration_updates')).rows[0].count),
      2,
    );
  } finally {
    await leader.close();
    await db.close();
  }
});

test('Pipelined failures drain the connection and roll back all queued writes', async () => {
  const db = await testDatabase(),
    leader = new Leadership(db.url, () => {}),
    pool = new pg.Pool({ connectionString: db.url, max: 1, pipeline: true });
  await leader.start();
  const store = new Store(pool, leader),
    identity = { ...db, key: db.user };
  try {
    const state = await store.open(identity);
    const pid = (await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const block = randomUUID(),
      receipt = randomUUID();
    const append = (updates: Uint8Array[]) =>
      store.append(
        state.generation,
        1,
        updates.map((update) => ({ identity, receipt, update })),
        updates[0]!,
        [],
        [block],
      );
    await db.pool.query(
      `CREATE FUNCTION test_reservation_failure() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'reservation failure'; END $$; CREATE TRIGGER test_reservation_failure BEFORE INSERT ON collaboration_block_ids FOR EACH ROW EXECUTE FUNCTION test_reservation_failure()`,
    );
    await assert.rejects(append([new Uint8Array([0, 0])]), /reservation failure/);
    await db.pool.query(
      'DROP TRIGGER test_reservation_failure ON collaboration_block_ids; DROP FUNCTION test_reservation_failure()',
    );
    // The last receipt is invalid: earlier queued inserts and reservations must also roll back.
    await assert.rejects(
      append([new Uint8Array([0, 0]), new Uint8Array([1, 0])]),
      /RECEIPT_REUSED/,
    );
    for (const table of [
      'collaboration_block_ids',
      'collaboration_receipts',
      'collaboration_updates',
    ])
      assert.equal(Number((await pool.query(`SELECT count(*) FROM ${table}`)).rows[0].count), 0);
    assert.equal((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
    await append([new Uint8Array([0, 0])]);
    assert.equal(
      Number((await pool.query('SELECT count(*) FROM collaboration_updates')).rows[0].count),
      1,
    );
    await db.pool.query('UPDATE collaboration_leadership SET epoch=epoch+1');
    let called = false;
    await assert.rejects(
      store.transaction(async () => {
        called = true;
      }, identity),
      /LEADERSHIP_LOST/,
    );
    assert.equal(called, false);
    assert.equal((await pool.query('SELECT pg_backend_pid() AS pid')).rows[0].pid, pid);
  } finally {
    await pool.end();
    await leader.close();
    await db.close();
  }
});
