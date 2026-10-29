import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { FileCells, readFileLimits } from '@memoria/db';
import { cellFixture } from './database-cell-fixture.ts';
test('7a real SQL files cells: guest task, independent CAS, hidden links, revocation and rollback', async (t) => {
  const fixture = await cellFixture(),
    { db, bases, rows, guest, grant } = fixture;
  const service = new FileCells(db.pool),
    a = { ...guest, key: 'guest', page: rows[0]!, rowScope: { database: bases[0]! } };
  const properties = [randomUUID(), randomUUID()],
    files = [randomUUID(), randomUUID()];
  try {
    for (let i = 0; i < 2; i++) {
      await db.pool.query(
        "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position) VALUES($1,$2,$3,$1::uuid::text,'Files','files','a0')",
        [properties[i], db.workspace, bases[0]],
      );
      await db.pool.query(
        "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$1::uuid::text,'task asset','application/octet-stream',10,'ready')",
        [files[i], db.workspace],
      );
      await db.pool.query(
        "INSERT INTO file_upload_intents(file_id,workspace_id,user_id,page_id,idempotency_key,requested_bytes,reserved_bytes,request_hash,expires_at,absolute_expires_at,attach_until) VALUES($1,$2,$3,$4,$1,10,10,'fixture',now()+interval '1 day',now()+interval '7 days',now()+interval '1 day')",
        [files[i], db.workspace, guest.user, rows[0]],
      );
    }
    const schema = (
      await db.pool.query('SELECT schema_version FROM databases WHERE id=$1', [bases[0]])
    ).rows[0].schema_version as string;
    await t.test('guest edit can attach independently to two cells of the same task', async () => {
      const results = await Promise.all(
        properties.map((p, i) =>
          service.write(a, p, schema, '0', { add: [files[i]!], remove: [] }),
        ),
      );
      assert.deepEqual(
        results.map((r) => r.version),
        ['1', '1'],
      );
      assert.equal(
        (await db.pool.query("SELECT * FROM file_usages WHERE slot_kind='cell'")).rowCount,
        2,
      );
    });
    await t.test('same cell rejects stale version; schema version is independent', async () => {
      await assert.rejects(
        service.write(a, properties[0]!, schema, '0', { add: [], remove: [] }),
        /CELL_VERSION_CONFLICT/,
      );
      await assert.rejects(
        service.write(a, properties[0]!, String(BigInt(schema) + 1n), '1', { add: [], remove: [] }),
        /SCHEMA_VERSION_CONFLICT/,
      );
    });
    await t.test(
      'hidden file is preserved by clear-visible and emits only one neutral marker',
      async () => {
        await db.pool.query('UPDATE files SET deleted_at=now() WHERE id=$1', [files[0]]);
        const result = await service.write(a, properties[0]!, schema, '1', {
          add: [],
          remove: [],
          clearVisible: true,
        });
        assert.deepEqual(result.value, { items: [], hasHidden: true });
        assert.equal(JSON.stringify(result).includes(files[0]!), false);
        await assert.rejects(
          service.write(a, properties[0]!, schema, '2', { add: [files[0]!], remove: [] }),
          /FILE_UNAVAILABLE/,
        );
        assert.equal(
          (await db.pool.query('SELECT * FROM file_usages WHERE file_id=$1', [files[0]])).rowCount,
          1,
        );
      },
    );
    await t.test(
      'read-only grant cannot change file values and known random IDs are rejected',
      async () => {
        await assert.rejects(
          service.write(a, properties[1]!, schema, '1', { add: [randomUUID()], remove: [] }),
          /FILE_UNAVAILABLE/,
        );
        await db.pool.query("UPDATE access_grants SET level='read' WHERE id=$1", [grant]);
        await assert.rejects(
          service.write(a, properties[1]!, schema, '1', { add: [], remove: [files[1]!] }),
          /FILE_UNAVAILABLE/,
        );
        await db.pool.query("UPDATE access_grants SET level='edit' WHERE id=$1", [grant]);
      },
    );
    await t.test('failure after usage removal rolls back links and cell version', async () => {
      await db.pool.query(
        "CREATE FUNCTION test_cell_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture cell failure'; END $$; CREATE TRIGGER test_cell_fail BEFORE UPDATE ON database_cell_versions FOR EACH ROW EXECUTE FUNCTION test_cell_fail()",
      );
      try {
        await assert.rejects(
          service.write(a, properties[1]!, schema, '1', { add: [], remove: [files[1]!] }),
          /fixture cell failure/,
        );
      } finally {
        await db.pool.query(
          'DROP TRIGGER test_cell_fail ON database_cell_versions; DROP FUNCTION test_cell_fail()',
        );
      }
      assert.equal(
        (await db.pool.query('SELECT * FROM file_usages WHERE file_id=$1', [files[1]])).rowCount,
        1,
      );
      assert.equal(
        (
          await db.pool.query('SELECT version FROM database_cell_versions WHERE property_id=$1', [
            properties[1],
          ])
        ).rows[0].version,
        '1',
      );
    });
    await t.test(
      'two disjoint cells cannot race past the shared page reference quota',
      async () => {
        await db.pool.query('UPDATE files SET deleted_at=NULL WHERE id=$1', [files[0]]);
        const extra = [randomUUID(), randomUUID()];
        for (const id of extra)
          await db.pool.query(
            "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position) VALUES($1,$2,$3,$1::uuid::text,'Quota','files','a1')",
            [id, db.workspace, bases[0]],
          );
        const currentSchema = (
          await db.pool.query('SELECT schema_version FROM databases WHERE id=$1', [bases[0]])
        ).rows[0].schema_version as string;
        const capped = new FileCells(db.pool, { ...readFileLimits(), pageReferences: 3 });
        const outcomes = await Promise.allSettled(
          extra.map((p, i) =>
            capped.write(a, p, currentSchema, '0', { add: [files[i]!], remove: [] }),
          ),
        );
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
        const rejected = outcomes.find((r) => r.status === 'rejected') as PromiseRejectedResult;
        assert.match(String(rejected.reason), /FILE_REFERENCE_LIMIT/);
        assert.equal(
          (await db.pool.query('SELECT * FROM file_usages WHERE page_id=$1', [a.page])).rowCount,
          3,
        );
      },
    );
  } finally {
    await db.close();
  }
});
