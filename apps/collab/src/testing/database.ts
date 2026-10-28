import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
/** Every integration suite applies the real migrations in its own disposable schema. */
export async function testDatabase(options: { queryTimeoutMs?: number } = {}) {
  const base = process.env.DATABASE_URL;
  if (
    !base ||
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname)
  )
    throw new Error('Integration tests require local development PostgreSQL');
  const schema = `memoria_collab_test_${randomUUID().replaceAll('-', '')}`;
  const admin = new pg.Client({ connectionString: base });
  await admin.connect();
  await admin.query(`CREATE SCHEMA "${schema}"`);
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const pool = new pg.Pool({
    connectionString: url.toString(),
    max: 12,
    query_timeout: options.queryTimeoutMs ?? 10000,
    connectionTimeoutMillis: 5000,
    pipeline: true,
  });
  const client = await pool.connect();
  try {
    const folder =
      process.env.COLLAB_TEST_MIGRATIONS ??
      fileURLToPath(new URL('../../../../packages/db/drizzle/', import.meta.url));
    for (const name of (await readdir(folder)).filter((n) => n.endsWith('.sql')).sort())
      await client.query(
        (await readFile(`${folder}/${name}`, 'utf8')).replaceAll('"public".', `"${schema}".`),
      );
    const user = randomUUID(),
      session = randomUUID(),
      workspace = randomUUID(),
      page = randomUUID(),
      actor = randomUUID(),
      generation = randomUUID();
    await client.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Test',$2,true)",
      [user, `${user}@example.test`],
    );
    await client.query("INSERT INTO workspaces(id,name,slug) VALUES($1,'Integration',$2)", [
      workspace,
      workspace,
    ]);
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [workspace, user],
    );
    await client.query("INSERT INTO actors(id,workspace_id,user_id,kind) VALUES($1,$2,$3,'user')", [
      actor,
      workspace,
      user,
    ]);
    await client.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
      [session, user, randomUUID()],
    );
    await client.query("INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,'a0')", [
      page,
      workspace,
    ]);
    return {
      pool,
      client,
      url: url.toString(),
      schema,
      user,
      session,
      workspace,
      page,
      actor,
      generation,
      async close() {
        client.release();
        await pool.end();
        if (!/^memoria_collab_test_[a-f0-9]{32}$/.test(schema))
          throw new Error('Invalid test cleanup schema');
        await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
        await admin.end();
      },
    };
  } catch (error) {
    client.release();
    await pool.end();
    await admin.query(`DROP SCHEMA "${schema}" CASCADE`);
    await admin.end();
    throw error;
  }
}
export type TestDatabase = Awaited<ReturnType<typeof testDatabase>>;
