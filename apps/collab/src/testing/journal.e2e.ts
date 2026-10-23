import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
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
