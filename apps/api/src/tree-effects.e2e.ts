import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';

await test('6d native tree mutations preserve per-page effects and atomic rollback', async () => {
  const h = await databaseHttpFixture();
  const { db, containers } = h.f;
  try {
    const owner = await h.account('owner'),
      guest = await h.account('guest');
    const ids = Array.from({ length: 40 }, () => randomUUID()),
      root = ids[0]!;
    await db.pool.query(
      "INSERT INTO pages(id,workspace_id,parent_id,position,title) VALUES($1,$2,$3,'a1','Tree 0')",
      [root, db.workspace, containers[0]],
    );
    await db.pool.query(
      "INSERT INTO pages(id,workspace_id,parent_id,position,title) SELECT id,$2,$3,'a'||ordinal,'Tree '||ordinal FROM unnest($1::uuid[]) WITH ORDINALITY t(id,ordinal)",
      [ids.slice(1), db.workspace, root],
    );
    const base = `/api/internal/workspaces/${db.workspace}/pages/${root}`;
    const current = async () =>
      Number(
        (await db.pool.query('SELECT version FROM pages WHERE id=$1', [root])).rows[0].version,
      );
    const input = async (action: string, parentId = containers[1]) => {
      const body = {
        expectedVersion: await current(),
        ...(action === 'move' ? { parentId, afterId: null } : {}),
      };
      if (action === 'archive') return body;
      const preview = await h.call(owner, body, base + '/' + action + '/preview');
      assert.equal(preview.status, 201);
      assert.equal(preview.data.pages, 40);
      return { ...body, previewToken: preview.data.token };
    };
    const snapshot = async () => {
      const pages = (
        await db.pool.query(
          'SELECT id,parent_id,version,position,deleted_at FROM pages WHERE id=ANY($1::uuid[]) ORDER BY id',
          [ids],
        )
      ).rows;
      const search = (
        await db.pool.query(
          'SELECT page_id,plain_text,page_version FROM search_documents WHERE page_id=ANY($1::uuid[]) ORDER BY page_id',
          [ids],
        )
      ).rows;
      const audit = (
        await db.pool.query(
          'SELECT resource_id,action,metadata FROM audit_logs WHERE resource_id=ANY($1::uuid[]) ORDER BY resource_id,action,metadata::text',
          [ids],
        )
      ).rows;
      const outbox = (
        await db.pool.query(
          'SELECT aggregate_id,aggregate_version,payload FROM outbox_events WHERE aggregate_id=ANY($1::uuid[]) ORDER BY aggregate_id,aggregate_version',
          [ids],
        )
      ).rows;
      return { pages, search, audit, outbox };
    };
    for (const [index, action] of ['move', 'archive', 'restore'].entries()) {
      const body = await input(action);
      assert.equal((await h.call(guest, body, base + '/' + action)).status, 403);
      const response = await h.call(owner, body, base + '/' + action);
      assert.equal(response.status, 201, JSON.stringify(response.data));
      const state = await snapshot();
      assert(state.pages.every((p) => Number(p.version) === index + 2));
      assert.equal(state.audit.length, 40 * (index + 1));
      assert.equal(state.outbox.length, 40 * (index + 1));
      assert.equal(state.search.length, action === 'archive' ? 0 : 40);
      for (const item of state.search) {
        assert.equal(Number(item.page_version), index + 2);
        assert.match(item.plain_text, /^Tree \d+$/);
      }
      for (const page of state.pages) {
        const events = state.outbox.filter((e) => e.aggregate_id === page.id);
        assert.equal(events.length, index + 1);
        assert.deepEqual(
          events.map((e) => Number(e.aggregate_version)),
          Array.from({ length: index + 1 }, (_, i) => i + 2),
        );
        assert(
          events.every(
            (e) =>
              e.payload.data.pageId === page.id &&
              e.payload.data.pageVersion === Number(e.aggregate_version),
          ),
        );
      }
    }
    const body = await input('move', containers[0]);
    const before = await snapshot();
    assert.equal(
      (await h.call(owner, { ...body, expectedVersion: 1 }, base + '/move')).status,
      409,
    );
    assert.deepEqual(await snapshot(), before);
    // Fail AFTER page updates and search effects: the entire batch must roll back.
    await db.pool.query(
      "CREATE FUNCTION fail_tree_effect() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN IF NEW.action='page.move' THEN RAISE EXCEPTION 'test effect failure'; END IF; RETURN NEW; END $$; CREATE TRIGGER fail_tree_effect BEFORE INSERT ON audit_logs FOR EACH ROW EXECUTE FUNCTION fail_tree_effect()",
    );
    assert.equal((await h.call(owner, body, base + '/move')).status, 500);
    assert.deepEqual(await snapshot(), before);
    await db.pool.query('DROP TRIGGER fail_tree_effect ON audit_logs');
    assert.equal((await h.call(owner, body, base + '/move')).status, 201);
    assert.equal((await snapshot()).outbox.length, 160);
  } finally {
    await h.close();
  }
});
