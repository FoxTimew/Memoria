import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import { FileBoundary, readFileLimits } from '@memoria/db';
import { testDatabase } from './database.ts';
import { Leadership } from '../service/leadership.ts';
import { Store } from '../service/store.ts';
import { Room } from '../service/room.ts';
import { applyCommands } from '../service/commands.ts';

test('7a real PostgreSQL: atomic reservations, account/instance admission and immutable plans', async (t) => {
  const db = await testDatabase(),
    a = {
      workspace: db.workspace,
      page: db.page,
      user: db.user,
      session: db.session,
      key: 'owner',
    };
  const limits = {
    ...readFileLimits(),
    maxBytes: 10000,
    workspaceBytes: 1300,
    derivativeBytes: 100,
    activeFiles: 20,
    partBytes: 100,
    burstBytes: 400,
    bytesPerSecond: 1,
    activeParts: 4,
    instanceParts: 4,
  };
  const boundary = new FileBoundary(db.pool, limits);
  try {
    let file = '';
    await t.test('concurrent idempotent initiation reserves exactly once', async () => {
      const request = { bytes: 1000, name: 'fixture.bin', idempotency: randomUUID() };
      const results = await Promise.all(
        Array.from({ length: 8 }, () => boundary.reserve(a, request)),
      );
      assert.equal(new Set(results).size, 1);
      file = results[0]!;
      assert.equal(
        Number(
          (await db.pool.query('SELECT reserved_bytes FROM file_workspace_usage')).rows[0]
            .reserved_bytes,
        ),
        1100,
      );
      await assert.rejects(
        boundary.reserve(a, { ...request, bytes: 1001 }),
        /IDEMPOTENCY_CONFLICT/,
      );
    });
    await t.test(
      'workspace cap remains atomic under racing reservations and includes pending files',
      async () => {
        const results = await Promise.allSettled(
          Array.from({ length: 6 }, () =>
            boundary.reserve(a, { bytes: 100, name: 'next', idempotency: randomUUID() }),
          ),
        );
        assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
        assert.equal(
          Number(
            (await db.pool.query('SELECT reserved_bytes FROM file_workspace_usage')).rows[0]
              .reserved_bytes,
          ),
          1300,
        );
      },
    );
    const checksum = Buffer.alloc(32, 1).toString('base64');
    await t.test(
      'same admission request never consumes a second lease; false progress cannot free it',
      async () => {
        const request = randomUUID(),
          parts = [{ number: 1, bytes: 100, checksum }];
        const first = await boundary.admitParts(a, file, request, parts);
        assert.deepEqual(await boundary.admitParts(a, file, request, parts), first);
        await boundary.admitParts(a, file, randomUUID(), [
          { number: 2, bytes: 100, checksum },
          { number: 3, bytes: 100, checksum },
          { number: 4, bytes: 100, checksum },
        ]);
        await assert.rejects(
          boundary.admitParts(a, file, randomUUID(), [{ number: 5, bytes: 100, checksum }]),
          /PART_CONCURRENCY_LIMIT/,
        );
        assert.equal(
          Number((await db.pool.query('SELECT count(*) FROM file_part_leases')).rows[0].count),
          4,
        );
      },
    );
    await t.test(
      'instance limit aggregates distinct accounts; own limit also holds independently',
      async () => {
        const user = randomUUID(),
          session = randomUUID();
        await db.pool.query(
          "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Another member',$2,true)",
          [user, user + '@example.test'],
        );
        await db.pool.query(
          "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member')",
          [db.workspace, user],
        );
        await db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
          db.workspace,
          user,
        ]);
        await db.pool.query(
          "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
          [session, user, randomUUID()],
        );
        const other = { ...a, user, session, key: 'other' };
        const shared = new FileBoundary(db.pool, { ...limits, workspaceBytes: 5000 });
        const another = await shared.reserve(other, {
          bytes: 100,
          name: 'another',
          idempotency: randomUUID(),
        });
        await assert.rejects(
          shared.admitParts(other, another, randomUUID(), [{ number: 1, bytes: 100, checksum }]),
          /PART_CONCURRENCY_LIMIT/,
        );
        // A larger instance budget cannot allow one account to exceed its own four leases.
        const larger = new FileBoundary(db.pool, { ...limits, instanceParts: 8 });
        await assert.rejects(
          larger.admitParts(a, file, randomUUID(), [{ number: 5, bytes: 100, checksum }]),
          /PART_CONCURRENCY_LIMIT/,
        );
      },
    );
    await t.test(
      'expired lease does not allow changing its checksum and logical byte budget still applies',
      async () => {
        await db.pool.query("UPDATE file_part_leases SET expires_at=now()-interval '1 second'");
        await assert.rejects(
          boundary.admitParts(a, file, randomUUID(), [
            { number: 1, bytes: 100, checksum: Buffer.alloc(32, 2).toString('base64') },
          ]),
          /PART_PLAN_CONFLICT/,
        );
        await assert.rejects(
          boundary.admitParts(a, file, randomUUID(), [{ number: 5, bytes: 100, checksum }]),
          /UPLOAD_ADMISSION_LIMIT/,
        );
      },
    );
    await t.test(
      'revoked session cannot reserve or sign; unknown ID is not an ownership proof',
      async () => {
        for (const state of ['completing', 'validating', 'ready', 'deleting']) {
          await db.pool.query('UPDATE files SET state=$2 WHERE id=$1', [file, state]);
          await assert.rejects(
            boundary.admitParts(a, file, randomUUID(), [{ number: 1, bytes: 100, checksum }]),
            /FILE_UNAVAILABLE/,
          );
        }
        await db.pool.query("UPDATE files SET state='reserved' WHERE id=$1", [file]);
        await assert.rejects(
          boundary.admitParts(a, randomUUID(), randomUUID(), [{ number: 1, bytes: 100, checksum }]),
          /FILE_UNAVAILABLE/,
        );
        await db.pool.query(
          "UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1",
          [db.session],
        );
        await assert.rejects(
          boundary.reserve(a, { bytes: 1, name: 'x', idempotency: randomUUID() }),
          /FILE_UNAVAILABLE/,
        );
        await assert.rejects(
          boundary.admitParts(a, file, randomUUID(), [{ number: 1, bytes: 100, checksum }]),
          /FILE_UNAVAILABLE/,
        );
      },
    );
  } finally {
    await db.close();
  }
});

test('7a actual Room journal: author attribution, rollback, independent usages and GC fences', async (t) => {
  const db = await testDatabase(),
    leader = new Leadership(db.url, () => {});
  await leader.start();
  const store = new Store(db.pool, leader),
    identity = {
      workspace: db.workspace,
      page: db.page,
      user: db.user,
      session: db.session,
      key: 'owner',
    };
  const state = await store.open(identity),
    doc = new Y.Doc(),
    room = new Room(store, db.page, state.generation, doc, () => {}),
    boundary = new FileBoundary(db.pool);
  const source = randomUUID(),
    sourceSlot = randomUUID(),
    file = randomUUID(),
    guest = randomUUID(),
    session = randomUUID();
  const attacker = { ...identity, user: guest, session, key: 'guest' };
  const input = (id: string, fileId: string) => ({
    op: 'insert' as const,
    id,
    parentId: null,
    afterId: null,
    type: 'core.image',
    schemaVersion: 1,
    content: { fileId, alt: '', caption: '', width: 512 },
  });
  function change(actorDoc: Y.Doc, operations: Parameters<typeof applyCommands>[1]) {
    const vector = Y.encodeStateVector(actorDoc);
    applyCommands(actorDoc, operations);
    return Y.encodeStateAsUpdate(actorDoc, vector);
  }
  function replica() {
    const d = new Y.Doc();
    d.getXmlFragment('prosemirror');
    Y.applyUpdate(d, Y.encodeStateAsUpdate(doc));
    return d;
  }
  try {
    await db.pool.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'source')", [
      source,
      db.workspace,
    ]);
    await db.pool.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Guest',$2,true)",
      [guest, guest + '@example.test'],
    );
    await db.pool.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'guest')",
      [db.workspace, guest],
    );
    await db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
      db.workspace,
      guest,
    ]);
    await db.pool.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [session, guest, randomUUID()],
    );
    const member = (
      await db.pool.query('SELECT id FROM workspace_members WHERE workspace_id=$1 AND user_id=$2', [
        db.workspace,
        guest,
      ])
    ).rows[0].id;
    const subject = randomUUID();
    await db.pool.query(
      "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3)",
      [subject, db.workspace, member],
    );
    await db.pool.query(
      "INSERT INTO access_grants(workspace_id,subject_id,resource_type,resource_id,level,inherit) VALUES($1,$2,'page',$3,'edit',true)",
      [db.workspace, subject, db.page],
    );
    await db.pool.query(
      "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$1::uuid::text,'fixture','application/octet-stream',10,'ready')",
      [file, db.workspace],
    );
    await db.pool.query(
      "INSERT INTO file_usages(workspace_id,file_id,page_id,slot_kind,slot_id,generation,revision) VALUES($1,$2,$3,'block',$4,$5,1)",
      [db.workspace, file, source, sourceSlot, randomUUID()],
    );
    await room.load();
    await t.test(
      'foreign workspace file and read-only destination cannot be admitted',
      async () => {
        const foreign = randomUUID(),
          otherFile = randomUUID();
        await db.pool.query(
          "INSERT INTO workspaces(id,name,slug) VALUES($1,'Foreign fixture',$1::uuid::text)",
          [foreign],
        );
        await db.pool.query(
          "INSERT INTO files(id,workspace_id,object_key,original_name,mime_type,byte_size,state) VALUES($1,$2,$1::uuid::text,'foreign','application/octet-stream',10,'ready')",
          [otherFile, foreign],
        );
        const d = replica();
        try {
          await assert.rejects(
            room.update(identity, change(d, [input(randomUUID(), otherFile)])),
            /FILE_UNAVAILABLE/,
          );
        } finally {
          d.destroy();
        }
        await db.pool.query("UPDATE access_grants SET level='read' WHERE subject_id=$1", [subject]);
        await assert.rejects(
          boundary.reserve(attacker, { bytes: 1, name: 'denied', idempotency: randomUUID() }),
          /FILE_UNAVAILABLE/,
        );
        await db.pool.query("UPDATE access_grants SET level='edit' WHERE subject_id=$1", [subject]);
      },
    );
    await t.test(
      'same workspace UUID without readable source is rejected before journal',
      async () => {
        const d = replica();
        try {
          await assert.rejects(
            room.update(attacker, change(d, [input(randomUUID(), file)])),
            /FILE_UNAVAILABLE/,
          );
        } finally {
          d.destroy();
        }
        assert.equal((await db.pool.query('SELECT * FROM collaboration_updates')).rowCount, 0);
        assert.equal(
          (await db.pool.query('SELECT * FROM file_usages WHERE page_id=$1', [db.page])).rowCount,
          0,
        );
      },
    );
    await t.test(
      'batched attacker cannot borrow a privileged author; innocent contribution succeeds',
      async () => {
        const bad = replica(),
          good = replica();
        try {
          const results = await Promise.allSettled([
            room.update(attacker, change(bad, [input(randomUUID(), file)])),
            room.update(identity, change(good, [input(randomUUID(), file)])),
          ]);
          assert.equal(results[0]!.status, 'rejected');
          assert.equal(results[1]!.status, 'fulfilled');
        } finally {
          bad.destroy();
          good.destroy();
        }
        assert.equal(
          (await db.pool.query('SELECT * FROM file_usages WHERE page_id=$1', [db.page])).rowCount,
          1,
        );
        assert.equal(
          (
            await db.pool.query(
              'SELECT * FROM collaboration_receipts WHERE actor_id=(SELECT id FROM actors WHERE user_id=$1)',
              [guest],
            )
          ).rowCount,
          0,
        );
      },
    );
    await t.test(
      'usage is durable independently of lagging projection; destination remains a valid source',
      async () => {
        assert.equal((await db.pool.query('SELECT * FROM file_references')).rowCount, 0);
        await db.pool.query('DELETE FROM file_usages WHERE page_id=$1', [source]);
        const d = replica();
        try {
          await room.update(attacker, change(d, [input(randomUUID(), file)]));
        } finally {
          d.destroy();
        }
        assert.equal(
          (await db.pool.query('SELECT * FROM file_usages WHERE page_id=$1', [db.page])).rowCount,
          2,
        );
      },
    );
    await t.test('journal failure rolls back usage and ledger revision together', async () => {
      const revision = room.revision,
        d = replica();
      await db.pool.query(
        "CREATE FUNCTION test_file_fail() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'fixture journal failure'; END $$; CREATE TRIGGER test_file_fail BEFORE INSERT ON collaboration_updates FOR EACH ROW EXECUTE FUNCTION test_file_fail()",
      );
      try {
        await assert.rejects(
          room.update(identity, change(d, [input(randomUUID(), file)])),
          /fixture journal failure/,
        );
      } finally {
        d.destroy();
        await db.pool.query(
          'DROP TRIGGER test_file_fail ON collaboration_updates; DROP FUNCTION test_file_fail()',
        );
      }
      assert.equal(
        (await db.pool.query('SELECT * FROM file_usages WHERE page_id=$1', [db.page])).rowCount,
        2,
      );
      assert.equal(
        Number(
          (
            await db.pool.query('SELECT revision FROM file_ledger_states WHERE page_id=$1', [
              db.page,
            ])
          ).rows[0].revision,
        ),
        revision,
      );
    });
    await t.test(
      'source removed after planning is rejected at the transaction boundary',
      async () => {
        const plan = await boundary.plan([{ slot: randomUUID(), file, author: identity }], db.page);
        const removed = (
          await db.pool.query<{ slot_id: string }>('SELECT slot_id FROM file_usages WHERE id=$1', [
            plan.sources[0]!.source!.id,
          ])
        ).rows[0]!;
        await db.pool.query('DELETE FROM file_usages WHERE id=$1', [plan.sources[0]!.source!.id]);
        await assert.rejects(
          boundary.transaction(async (c) => {
            await boundary.lock(c, db.workspace, plan);
            await boundary.authorize(c, plan);
          }),
          /FILE_UNAVAILABLE/,
        );
        // Restore exactly the removed fixture usage to keep the document/ledger pair consistent.
        const r = plan.sources[0]!;
        await db.pool.query(
          "INSERT INTO file_usages(id,workspace_id,file_id,page_id,slot_kind,slot_id,generation,revision) VALUES($1,$2,$3,$4,'block',$5,$6,$7)",
          [
            r.source!.id,
            db.workspace,
            file,
            db.page,
            removed.slot_id,
            state.generation,
            room.revision,
          ],
        );
      },
    );
    await t.test('deleting file cannot gain a new usage, even via direct SQL', async () => {
      await db.pool.query("UPDATE files SET state='deleting' WHERE id=$1", [file]);
      await assert.rejects(
        db.pool.query(
          "INSERT INTO file_usages(workspace_id,file_id,page_id,slot_kind,slot_id,generation,revision) VALUES($1,$2,$3,'block',$4,$5,1)",
          [db.workspace, file, db.page, randomUUID(), state.generation],
        ),
        /Unavailable file/,
      );
      const d = replica();
      try {
        await assert.rejects(
          room.update(identity, change(d, [input(randomUUID(), file)])),
          /FILE_UNAVAILABLE/,
        );
      } finally {
        d.destroy();
      }
    });
  } finally {
    await room.close();
    doc.destroy();
    await leader.close();
    await db.close();
  }
});
