import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { test } from 'node:test';
import { DatabaseFault, resolvePageAccess } from '@memoria/db';
import { cellFixture } from './database-cell-fixture.ts';

const fault = (code: string) => (e: unknown) => e instanceof DatabaseFault && e.code === code;
test('6a cell kernel: real PostgreSQL concurrency, rights, hidden links and rollback', async (t) => {
  const f = await cellFixture();
  const { db, cells, address, owner, guest, bases, rows, properties, options } = f;
  const write = (
    kind: string,
    value: unknown,
    expected = '0',
    schema = '1',
    subject = owner,
    row = rows[0]!,
  ) =>
    cells.write(subject, {
      ...address(kind, row),
      value,
      expectedCellVersion: expected,
      expectedSchemaVersion: schema,
    });
  const waiting = async (pid: number) => {
    const end = Date.now() + 3000;
    while (
      !(
        await db.pool.query('SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))', [
          pid,
        ])
      ).rowCount
    ) {
      assert(Date.now() < end, 'expected a real lock wait');
      await delay(5);
    }
  };
  try {
    await t.test(
      'version zero races; clear retains tombstone; response replay cannot overwrite',
      async () => {
        const outcomes = await Promise.allSettled([write('text', 'a'), write('text', 'b')]);
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
        assert(
          outcomes.some((r) => r.status === 'rejected' && fault('CELL_VERSION_CONFLICT')(r.reason)),
        );
        const cleared = await write('text', '', '1');
        assert.equal(cleared.value, null);
        assert.equal(cleared.version, '2');
        await assert.rejects(write('text', 'stale', '0'), fault('CELL_VERSION_CONFLICT'));
        await write('text', 'new', '2');
        await assert.rejects(write('text', 'retry', '2'), fault('CELL_VERSION_CONFLICT'));
      },
    );
    await t.test(
      'nine types validate; false/zero remain different from empty; title and Yjs versions untouched',
      async () => {
        const pageBefore = (await db.pool.query('SELECT version FROM pages WHERE id=$1', [rows[0]]))
          .rows[0];
        assert.equal((await write('checkbox', false)).value, false);
        assert.equal((await write('checkbox', null, '1')).value, null);
        assert.equal((await write('number', '0')).value, '0.00000000');
        await assert.rejects(write('number', '1.000000001', '1'), fault('INVALID_CELL'));
        await assert.rejects(write('number', 'NaN', '1'), fault('INVALID_CELL'));
        await write('date', { start: '2026-10-26', end: '2026-10-27' });
        await assert.rejects(write('date', { start: '2026-02-30' }, '1'), fault('INVALID_CELL'));
        await write('instant', { start: '2026-10-26T12:00:00+01:00', timeZone: 'Europe/Paris' });
        await assert.rejects(
          write('instant', { start: '2026-02-30T12:00:00Z', timeZone: 'Europe/Paris' }, '1'),
          fault('INVALID_CELL'),
        );
        await assert.rejects(
          write('instant', { start: '2026-10-26T12:00:00', timeZone: 'Europe/Paris' }, '1'),
          fault('INVALID_CELL'),
        );
        await assert.rejects(write('url', 'javascript:alert(1)'), fault('INVALID_CELL'));
        await assert.rejects(
          write('url', 'https://user:password@example.test/'),
          fault('INVALID_CELL'),
        );
        await write('url', 'https://example.test/');
        await write('select', options.select![0]);
        await write('multi_select', options.multi_select!);
        await assert.rejects(
          write('select', options.multi_select![0], '1'),
          fault('REFERENCE_UNAVAILABLE'),
        );
        await assert.rejects(
          write('multi_select', [options.multi_select![0], options.multi_select![0]], '1'),
          fault('INVALID_CELL'),
        );
        assert.deepEqual(
          (await db.pool.query('SELECT version FROM pages WHERE id=$1', [rows[0]])).rows[0],
          pageBefore,
        );
        assert.equal(
          (await db.pool.query('SELECT * FROM collaboration_updates WHERE page_id=$1', [rows[0]]))
            .rowCount,
          0,
        );
      },
    );
    await t.test(
      'different cells proceed while the other cell is locked; same set uses one CAS',
      async () => {
        const blocker = await db.pool.connect();
        let pending: Promise<unknown> | undefined;
        try {
          await blocker.query('BEGIN');
          await blocker.query(
            'SELECT * FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 FOR UPDATE',
            [db.workspace, rows[0], properties.text],
          );
          const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          pending = write('text', 'blocked', '3');
          void pending.catch(() => {});
          await waiting(pid);
          const other = await write('number', '42', '1');
          assert.equal(other.version, '2');
          await blocker.query('COMMIT');
          await pending;
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
        }
        const outcomes = await Promise.allSettled([
          write('multi_select', [options.multi_select![0]], '1'),
          write('multi_select', [options.multi_select![1]], '1'),
        ]);
        assert.equal(outcomes.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(outcomes.filter((r) => r.status === 'rejected').length, 1);
      },
    );
    await t.test(
      'hidden relations survive clearVisible; unavailable and invented IDs have identical errors',
      async () => {
        await write('relation', { add: [rows[2], rows[3]] });
        assert.deepEqual((await cells.read(guest, address('relation'))).value, {
          items: [],
          hasHidden: true,
        });
        for (const id of [rows[2]!, randomUUID(), rows[1]!])
          await assert.rejects(
            write('relation', { remove: [id] }, '1', '1', guest),
            (e) =>
              fault('REFERENCE_UNAVAILABLE')(e) &&
              JSON.stringify(e) === '{"status":400,"code":"REFERENCE_UNAVAILABLE"}',
          );
        await write('relation', { clearVisible: true }, '1', '1', guest);
        assert.equal(
          (await db.pool.query('SELECT * FROM relation_values WHERE row_page_id=$1', [rows[0]]))
            .rowCount,
          2,
        );
        await db.pool.query(
          "INSERT INTO access_grants(workspace_id,subject_id,resource_id,level,inherit) VALUES($1,$2,$3,'read',true)",
          [db.workspace, f.guestSubject, f.containers[1]],
        );
        await cells.setArchived(owner, bases[1]!, rows[3]!, '1', true);
        const visible = (await cells.read(guest, address('relation'))).value as {
          items: { id: string }[];
          hasHidden: boolean;
        };
        assert.deepEqual(
          visible.items.map((x) => x.id),
          [rows[2]],
        );
        assert(visible.hasHidden);
        await write('relation', { clearVisible: true }, '2', '1', guest);
        assert.deepEqual(
          (
            await db.pool.query('SELECT target_page_id FROM relation_values WHERE row_page_id=$1', [
              rows[0],
            ])
          ).rows,
          [{ target_page_id: rows[3] }],
        );
        await cells.setArchived(owner, bases[1]!, rows[3]!, '2', false);
        assert.equal(
          ((await cells.read(guest, address('relation'))).value as { hasHidden: boolean })
            .hasHidden,
          false,
        );
      },
    );
    await t.test(
      'person visibility is explicit; withdrawal detaches without deleting assignments',
      async () => {
        const member = (
          await db.pool.query(
            'SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2',
            [db.workspace, owner.user],
          )
        ).rows[0].id;
        await write('person', { add: [member, f.guestMember] });
        const value = (await cells.read(guest, address('person'))).value as {
          items: { id: string; name: string }[];
          hasHidden: boolean;
        };
        assert.deepEqual(
          value.items.map((x) => x.id),
          [f.guestMember],
        );
        assert(value.hasHidden);
        assert(!JSON.stringify(value).includes('@'));
        await assert.rejects(
          write('person', { add: [member] }, '1', '1', guest),
          fault('REFERENCE_UNAVAILABLE'),
        );
        await db.pool.query(
          'INSERT INTO database_assignable_people(workspace_id,database_id,person_id) VALUES($1,$2,$3)',
          [db.workspace, bases[0], member],
        );
        assert.equal(
          ((await cells.read(guest, address('person'))).value as { items: unknown[] }).items.length,
          2,
        );
        await db.pool.query('DELETE FROM database_assignable_people WHERE person_id=$1', [member]);
        await write('person', { clearVisible: true }, '1', '1', guest);
        assert.equal(
          (await db.pool.query('SELECT * FROM person_values WHERE row_page_id=$1', [rows[0]]))
            .rowCount,
          1,
        );
      },
    );
    await t.test(
      'guest read and schema/lifecycle spoofing fail; source access checked before validation',
      async () => {
        await assert.rejects(
          cells.changeSchema(guest, bases[0]!, '1', properties.text!, { name: 'Forbidden' }),
          fault('ACCESS_DENIED'),
        );
        await assert.rejects(
          cells.setArchived(guest, bases[0]!, rows[0]!, '1', true),
          fault('ACCESS_DENIED'),
        );
        await db.pool.query("UPDATE access_grants SET level='read' WHERE id=$1", [f.grant]);
        await assert.rejects(write('number', '55', '2', '1', guest), fault('ACCESS_DENIED'));
        await db.pool.query("UPDATE access_grants SET level='edit' WHERE id=$1", [f.grant]);
        await assert.rejects(
          cells.write(guest, {
            ...address('text'),
            database: bases[1]!,
            value: 'bad',
            expectedSchemaVersion: '1',
            expectedCellVersion: '0',
          }),
          fault('ACCESS_DENIED'),
        );
        await assert.rejects(
          cells.read({ ...guest, session: randomUUID() }, address('text')),
          fault('ACCESS_DENIED'),
        );
      },
    );
    await t.test('schema race waits, rechecks the version and preserves values', async () => {
      const c = await db.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query('UPDATE databases SET schema_version=schema_version+1 WHERE id=$1', [
          bases[0],
        ]);
        const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const pending = write('text', 'old schema', '4');
        void pending.catch(() => {});
        await waiting(pid);
        await c.query('COMMIT');
        await assert.rejects(pending, fault('SCHEMA_VERSION_CONFLICT'));
        assert.equal((await cells.read(owner, address('text'))).value, 'blocked');
      } finally {
        await c.query('ROLLBACK');
        c.release();
      }
      assert.equal(
        (await cells.changeSchema(owner, bases[0]!, '2', properties.text!, { name: 'Renamed' }))
          .schemaVersion,
        '3',
      );
      await assert.rejects(
        cells.changeSchema(owner, bases[0]!, '2', properties.text!, { archived: true }),
        fault('SCHEMA_VERSION_CONFLICT'),
      );
    });
    await t.test(
      'revocation first: queued write is refused with no value in the error',
      async () => {
        const c = await db.pool.connect();
        try {
          await c.query('BEGIN');
          await c.query("UPDATE access_grants SET level='read' WHERE id=$1", [f.grant]);
          const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          const pending = write('text', 'must not commit', '4', '3', guest);
          void pending.catch(() => {});
          await waiting(pid);
          await c.query('COMMIT');
          await assert.rejects(
            pending,
            (e) => fault('ACCESS_DENIED')(e) && !(e as DatabaseFault).current,
          );
          assert.equal((await cells.read(owner, address('text'))).version, '4');
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
        await db.pool.query("UPDATE access_grants SET level='edit' WHERE id=$1", [f.grant]);
      },
    );
    await t.test('write first: rights commit waits until the authorized cell commit', async () => {
      const cell = await db.pool.connect(),
        revoke = await db.pool.connect();
      try {
        await cell.query('BEGIN');
        await cell.query(
          'SELECT * FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 FOR UPDATE',
          [db.workspace, rows[0], properties.text],
        );
        const cellPid = (await cell.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const writePending = write('text', 'before revocation', '4', '3', guest);
        void writePending.catch(() => {});
        await waiting(cellPid);
        await revoke.query('BEGIN');
        const revokePid = (await revoke.query('SELECT pg_backend_pid() pid')).rows[0].pid;
        const revokePending = revoke.query("UPDATE access_grants SET level='read' WHERE id=$1", [
          f.grant,
        ]);
        void revokePending.catch(() => {});
        for (
          let n = 0;
          !(
            await db.pool.query(
              "SELECT 1 FROM pg_stat_activity WHERE pid=$1 AND wait_event_type='Lock'",
              [revokePid],
            )
          ).rowCount;
          n++
        ) {
          assert(n < 300);
          await delay(5);
        }
        await cell.query('COMMIT');
        await writePending;
        await revokePending;
        await revoke.query('COMMIT');
        assert.equal((await cells.read(owner, address('text'))).value, 'before revocation');
      } finally {
        await cell.query('ROLLBACK');
        await revoke.query('ROLLBACK');
        cell.release();
        revoke.release();
      }
      await db.pool.query("UPDATE access_grants SET level='edit' WHERE id=$1", [f.grant]);
    });
    await t.test(
      'lifecycle CAS, archive while waiting, and old lifecycle ticket rejection',
      async () => {
        const before = (
          await db.pool.query(
            'SELECT lifecycle_version::text FROM database_rows WHERE page_id=$1',
            [rows[0]],
          )
        ).rows[0].lifecycle_version;
        const c = await db.pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('SELECT database_lock_rows($1,ARRAY[$2::uuid],true)', [
            db.workspace,
            rows[0],
          ]);
          await c.query('UPDATE pages SET deleted_at=now(),version=version+1 WHERE id=$1', [
            rows[0],
          ]);
          const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          const pending = write('text', 'archived', '5', '3', guest);
          void pending.catch(() => {});
          await waiting(pid);
          await c.query('COMMIT');
          await assert.rejects(pending, fault('ACCESS_DENIED'));
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
        await assert.rejects(
          cells.setArchived(owner, bases[0]!, rows[0]!, '1', false),
          fault('PAGE_VERSION_CONFLICT'),
        );
        await cells.setArchived(owner, bases[0]!, rows[0]!, '2', false);
        const old = await resolvePageAccess(db.pool, [
          {
            ...guest,
            key: 'old',
            page: rows[0]!,
            rowScope: { database: bases[0]!, lifecycle: before },
          },
        ]);
        assert.equal(old.size, 0);
      },
    );
    await t.test(
      'write failure rolls back value, CAS version and row aggregate together',
      async () => {
        const before = await cells.read(owner, address('text'));
        const aggregate = (
          await db.pool.query('SELECT * FROM database_row_changes WHERE row_page_id=$1', [rows[0]])
        ).rows;
        await db.pool.query(
          `CREATE FUNCTION reject_test_value() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.text_value='FAULT' THEN RAISE EXCEPTION 'injected'; END IF; RETURN NEW; END $$; CREATE TRIGGER reject_test_value AFTER INSERT ON property_values FOR EACH ROW EXECUTE FUNCTION reject_test_value()`,
        );
        await assert.rejects(write('text', 'FAULT', before.version, '3'));
        assert.deepEqual(await cells.read(owner, address('text')), before);
        assert.deepEqual(
          (
            await db.pool.query('SELECT * FROM database_row_changes WHERE row_page_id=$1', [
              rows[0],
            ])
          ).rows,
          aggregate,
        );
      },
    );
    await t.test(
      'archived property rejects stale schema and new writes without deleting historical values',
      async () => {
        await cells.changeSchema(owner, bases[0]!, '3', properties.text!, { archived: true });
        await assert.rejects(write('text', 'old', '5', '3'), fault('SCHEMA_VERSION_CONFLICT'));
        await assert.rejects(write('text', 'hidden', '5', '4'), fault('ACCESS_DENIED'));
        assert.equal(
          (
            await db.pool.query(
              'SELECT * FROM property_values WHERE row_page_id=$1 AND property_id=$2',
              [rows[0], properties.text],
            )
          ).rowCount,
          1,
        );
      },
    );
    await t.test(
      '10,000 person references survive withdrawal without identity resurrection',
      async () => {
        const user = randomUUID(),
          member = randomUUID();
        await db.pool.query(
          "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Withdrawn fixture',$2,true)",
          [user, user + '@example.test'],
        );
        await db.pool.query(
          "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
          [member, db.workspace, user],
        );
        await db.pool.query(
          'INSERT INTO database_assignable_people(workspace_id,database_id,person_id) VALUES($1,$2,$3)',
          [db.workspace, bases[0], member],
        );
        const added = Array.from({ length: 9998 }, () => randomUUID()),
          allRows = [rows[0]!, rows[1]!, ...added];
        await db.pool.query(
          "INSERT INTO pages(id,workspace_id,kind,position) SELECT id,$1,'database_row','a0' FROM unnest($2::uuid[]) t(id)",
          [db.workspace, added],
        );
        await db.pool.query(
          'INSERT INTO database_rows(workspace_id,database_id,page_id) SELECT $1,$2,id FROM unnest($3::uuid[]) t(id)',
          [db.workspace, bases[0], added],
        );
        await db.pool.query(
          "INSERT INTO person_values(workspace_id,database_id,row_page_id,property_id,kind,member_id) SELECT $1,$2,id,$3,'person',$4 FROM unnest($5::uuid[]) t(id)",
          [db.workspace, bases[0], properties.person, member, allRows],
        );
        assert.equal(
          ((await cells.read(guest, address('person', rows[1]!))).value as { items: unknown[] })
            .items.length,
          1,
        );
        await db.pool.query('DELETE FROM workspace_members WHERE id=$1', [member]);
        assert.equal(
          (await db.pool.query('SELECT count(*) n FROM person_values WHERE member_id=$1', [member]))
            .rows[0].n,
          '10000',
        );
        assert.equal(
          (await db.pool.query('SELECT member_id FROM database_people WHERE id=$1', [member]))
            .rows[0].member_id,
          null,
        );
        assert.deepEqual((await cells.read(guest, address('person', rows[1]!))).value, {
          items: [],
          hasHidden: true,
        });
        await db.pool.query(
          "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
          [randomUUID(), db.workspace, user],
        );
        assert.deepEqual((await cells.read(guest, address('person', rows[1]!))).value, {
          items: [],
          hasHidden: true,
        });
      },
    );
    await t.test(
      'value and version stay coherent while a previously empty cell is repeatedly written',
      async () => {
        await Promise.all([
          (async () => {
            for (let n = 1; n <= 60; n++)
              await write('url', 'https://example.test/v' + n, String(n - 1), '4', owner, rows[1]!);
          })(),
          (async () => {
            for (let n = 0; n < 100; n++) {
              const value = await cells.read(guest, address('url', rows[1]!));
              assert.equal(
                value.value,
                value.version === '0' ? null : 'https://example.test/v' + value.version,
              );
            }
          })(),
        ]);
      },
    );
    await t.test(
      'target revocation while adding a relation is rechecked after the wait',
      async () => {
        const before = await cells.read(guest, address('relation'));
        const c = await db.pool.connect();
        try {
          await c.query('BEGIN');
          await c.query('DELETE FROM access_grants WHERE subject_id=$1 AND resource_id=$2', [
            f.guestSubject,
            f.containers[1],
          ]);
          const pid = (await c.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          const pending = write('relation', { add: [rows[2]] }, before.version, '4', guest);
          void pending.catch(() => {});
          await waiting(pid);
          await c.query('COMMIT');
          await assert.rejects(pending, fault('REFERENCE_UNAVAILABLE'));
          assert.equal((await cells.read(owner, address('relation'))).version, before.version);
        } finally {
          await c.query('ROLLBACK');
          c.release();
        }
      },
    );
    await t.test(
      'typed/base foreign keys reject populated type changes and foreign cell identities',
      async () => {
        await assert.rejects(
          db.pool.query("UPDATE database_properties SET kind='number' WHERE id=$1", [
            properties.text,
          ]),
          (e: unknown) => (e as { code: string }).code === '23514',
        );
        await assert.rejects(
          db.pool.query(
            'UPDATE database_properties SET config=\'{"mode":"instant"}\' WHERE id=$1',
            [properties.date],
          ),
          (e: unknown) => (e as { code: string }).code === '23514',
        );
        const foreign = randomUUID();
        await db.pool.query(
          "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position) VALUES($1,$2,$3,'foreign','Foreign','text','a0')",
          [foreign, db.workspace, bases[1]],
        );
        await assert.rejects(
          db.pool.query(
            'INSERT INTO database_cell_versions(workspace_id,database_id,row_page_id,property_id) VALUES($1,$2,$3,$4)',
            [db.workspace, bases[0], rows[0], foreign],
          ),
          (e: unknown) => (e as { code: string }).code === '23503',
        );
      },
    );
    await t.test('archived options may be retained or removed, never newly assigned', async () => {
      const setup = await cells.read(owner, address('multi_select'));
      await write('multi_select', options.multi_select!, setup.version, '4');
      await db.pool.query('UPDATE property_options SET deleted_at=now() WHERE id=ANY($1::uuid[])', [
        [options.select![0], options.multi_select![0]],
      ]);
      const current = await cells.read(owner, address('select'));
      await write('select', options.select![0], current.version, '4');
      await assert.rejects(
        write('select', options.select![0], '0', '4', guest, rows[1]!),
        fault('REFERENCE_UNAVAILABLE'),
      );
      const set = await cells.read(owner, address('multi_select'));
      await write('multi_select', options.multi_select!, set.version, '4');
      await assert.rejects(
        write('multi_select', [options.multi_select![0]], '0', '4', guest, rows[1]!),
        fault('REFERENCE_UNAVAILABLE'),
      );
      await write('select', null, (BigInt(current.version) + 1n).toString(), '4');
      await write('multi_select', [], (BigInt(set.version) + 1n).toString(), '4');
    });
    await t.test('option and assignable-list changes wait for the same base barrier', async () => {
      for (const sql of [
        'UPDATE property_options SET label=label WHERE id=$1',
        'UPDATE database_assignable_people SET person_id=person_id WHERE person_id=$1',
      ]) {
        const blocker = await db.pool.connect(),
          editor = await db.pool.connect();
        try {
          await blocker.query('BEGIN');
          await blocker.query('SELECT id FROM databases WHERE id=$1 FOR SHARE', [bases[0]]);
          const pid = (await blocker.query('SELECT pg_backend_pid() pid')).rows[0].pid;
          const target = sql.includes('property_options')
            ? options.select![1]
            : (
                await db.pool.query(
                  'SELECT person_id FROM database_assignable_people WHERE database_id=$1 LIMIT 1',
                  [bases[0]],
                )
              ).rows[0].person_id;
          const pending = editor.query(sql, [target]);
          void pending.catch(() => {});
          await waiting(pid);
          await blocker.query('COMMIT');
          await pending;
        } finally {
          await blocker.query('ROLLBACK');
          blocker.release();
          editor.release();
        }
      }
    });
  } finally {
    await db.close();
  }
});
