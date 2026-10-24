import { createRequire } from 'node:module';
const require = createRequire(new URL('../packages/db/package.json', import.meta.url));
const { Client } = require('pg');
const args = process.argv.slice(2),
  action = args[0];
const option = (name) => {
  const i = args.indexOf(name);
  return i < 0 ? undefined : args[i + 1];
};
const workspace = option('--workspace'),
  email = option('--email');
const url = process.env.DATABASE_URL;
if (
  process.env.NODE_ENV === 'production' ||
  !url ||
  !['127.0.0.1', 'localhost', '[::1]'].includes(new URL(url).hostname)
)
  throw new Error('This command is restricted to local development PostgreSQL.');
if (
  !/^[0-9a-f]{8}(-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(workspace ?? '') ||
  !['reset-legacy', 'add-member'].includes(action)
)
  throw new Error(
    'Usage: pnpm dev:collab reset-legacy|add-member --workspace UUID [--email EMAIL] [--apply --confirm UUID]',
  );
const db = new Client({ connectionString: url });
await db.connect();
try {
  await db.query('BEGIN');
  const found = await db.query(
    'SELECT id FROM workspaces WHERE id=$1 AND deleted_at IS NULL FOR UPDATE',
    [workspace],
  );
  if (!found.rowCount) throw new Error('Workspace not found');
  if (action === 'add-member') {
    if (!email) throw new Error('--email is required');
    const user = (
      await db.query('SELECT id,email_verified FROM auth_users WHERE lower(email)=lower($1)', [
        email,
      ])
    ).rows[0];
    if (!user?.email_verified)
      throw new Error('Create and verify the second account by email first.');
    await db.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'member') ON CONFLICT(workspace_id,user_id) DO NOTHING",
      [workspace, user.id],
    );
    await db.query(
      "INSERT INTO actors(workspace_id,user_id,kind) SELECT $1,$2,'user' WHERE NOT EXISTS(SELECT 1 FROM actors WHERE workspace_id=$1 AND user_id=$2)",
      [workspace, user.id],
    );
    console.log('Member available in workspace', workspace);
  } else {
    // Same advisory namespace as the service. Never reset under a live leader.
    const lock = (
      await db.query(
        'SELECT pg_try_advisory_xact_lock($1,hashtext(current_schema())) AS acquired',
        [1296387393],
      )
    ).rows[0];
    if (!lock.acquired) throw new Error('Stop apps/collab before resetting test content.');
    const pages = (
      await db.query(
        'SELECT id FROM pages p WHERE workspace_id=$1 AND EXISTS(SELECT 1 FROM blocks b WHERE b.page_id=p.id) AND NOT EXISTS(SELECT 1 FROM collaboration_documents c WHERE c.page_id=p.id) ORDER BY id FOR UPDATE',
        [workspace],
      )
    ).rows.map((p) => p.id);
    console.log(JSON.stringify({ workspace, legacyPages: pages, apply: args.includes('--apply') }));
    if (args.includes('--apply')) {
      if (option('--confirm') !== workspace)
        throw new Error('--confirm must repeat the exact workspace UUID');
      await db.query('DELETE FROM file_references WHERE page_id=ANY($1::uuid[])', [pages]);
      // Explicit development reset exception: no conversion, no production block writer fallback.
      await db.query('DELETE FROM blocks WHERE page_id=ANY($1::uuid[])', [pages]);
      await db.query('DELETE FROM search_documents WHERE page_id=ANY($1::uuid[])', [pages]);
      await db.query(
        'DELETE FROM audit_logs WHERE workspace_id=$1 AND resource_id=ANY($2::uuid[])',
        [workspace, pages],
      );
      await db.query(
        'DELETE FROM outbox_events WHERE workspace_id=$1 AND aggregate_id=ANY($2::uuid[])',
        [workspace, pages],
      );
      await db.query(
        'UPDATE pages SET version=version+1,updated_at=clock_timestamp() WHERE id=ANY($1::uuid[])',
        [pages],
      );
      await db.query(
        'INSERT INTO search_documents(workspace_id,page_id,plain_text,page_version) SELECT workspace_id,id,title,version FROM pages p WHERE id=ANY($1::uuid[]) AND deleted_at IS NULL AND NOT EXISTS(WITH RECURSIVE ancestors AS (SELECT parent_id,deleted_at FROM pages WHERE id=p.id UNION ALL SELECT a.parent_id,a.deleted_at FROM pages a JOIN ancestors x ON a.id=x.parent_id) SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)',
        [pages],
      );
      console.log(
        'Legacy test bodies reset; accounts, pages, titles, memberships and existing Yjs documents retained.',
      );
    }
  }
  await db.query('COMMIT');
} catch (error) {
  await db.query('ROLLBACK');
  throw error;
} finally {
  await db.end();
}
