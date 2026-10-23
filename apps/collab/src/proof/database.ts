import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import pg from 'pg';

/** Isolated proof schema, including the actual relational migrations. Never touches public. */
export async function proofDatabase() {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === 'production')
    throw new Error('Local DATABASE_URL required');
  if (!['localhost', '127.0.0.1', '[::1]'].includes(new URL(process.env.DATABASE_URL).hostname))
    throw new Error('Proof requires loopback PostgreSQL');
  const schema = `memoria_collab_proof_${randomUUID().replaceAll('-', '')}`;
  const client = new pg.Client({
    connectionString: process.env.DATABASE_URL,
    query_timeout: 10000,
  });
  await client.connect();
  const close = async () => {
    try {
      if (!/^memoria_collab_proof_[a-f0-9]{32}$/.test(schema))
        throw new Error('Unsafe cleanup schema');
      await client.query(`DROP SCHEMA IF EXISTS "${schema}" CASCADE`);
    } finally {
      await client.end();
    }
  };
  try {
    await client.query(`CREATE SCHEMA "${schema}"`);
    await client.query(`SET search_path TO "${schema}"`);
    await client.query('SET synchronous_commit TO on');
    const migrations = process.env.COLLAB_PROOF_MIGRATIONS;
    if (!migrations) throw new Error('Use scripts/proof-collab.mjs to resolve migrations');
    for (const name of (await readdir(migrations))
      .filter((name) => /^000[0-2]_.*\.sql$/.test(name))
      .sort()) {
      await client.query(
        (await readFile(`${migrations}/${name}`, 'utf8')).replaceAll('"public".', `"${schema}".`),
      );
    }
    await client.query(`CREATE TABLE collaboration_documents (
      page_id uuid PRIMARY KEY REFERENCES pages(id), generation uuid NOT NULL,
      snapshot bytea NOT NULL, snapshot_revision bigint NOT NULL DEFAULT 0,
      content_revision bigint NOT NULL DEFAULT 0, projection_revision bigint NOT NULL DEFAULT 0
    ); CREATE TABLE collaboration_updates (
      page_id uuid NOT NULL REFERENCES collaboration_documents(page_id), revision bigint NOT NULL,
      receipt uuid NOT NULL, author_id uuid NOT NULL REFERENCES auth_users(id),
      update bytea NOT NULL, created_at timestamptz NOT NULL DEFAULT now(),
      PRIMARY KEY(page_id, revision), UNIQUE(page_id, receipt)
    ); CREATE TABLE collaboration_receipts (
      page_id uuid NOT NULL REFERENCES collaboration_documents(page_id), receipt uuid NOT NULL,
      revision bigint NOT NULL, author_id uuid NOT NULL REFERENCES auth_users(id), update_hash text NOT NULL,
      PRIMARY KEY(page_id,receipt)
    ); CREATE FUNCTION proof_fail_journal() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF current_setting('memoria.proof_fail_journal',true)='on' THEN RAISE EXCEPTION 'Injected SQL journal failure'; END IF;
        RETURN NEW;
      END $$;
      CREATE TRIGGER proof_fail_journal BEFORE INSERT ON collaboration_updates FOR EACH ROW EXECUTE FUNCTION proof_fail_journal()`);
    const user = randomUUID(),
      session = randomUUID(),
      workspace = randomUUID(),
      page = randomUUID();
    await client.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES ($1,'Proof',$2,true)",
      [user, `${user}@example.test`],
    );
    await client.query(
      "INSERT INTO workspaces(id,name,slug) VALUES ($1,'Collaboration proof',$2)",
      [workspace, workspace],
    );
    await client.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'owner')",
      [workspace, user],
    );
    await client.query(
      "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES ($1,$2,$3,now()+interval '1 hour')",
      [session, user, randomUUID()],
    );
    await client.query("INSERT INTO pages(id,workspace_id,position) VALUES ($1,$2,'a0')", [
      page,
      workspace,
    ]);
    return { client, close, user, session, workspace, page, schema };
  } catch (error) {
    await close();
    throw error;
  }
}

export type ProofDatabase = Awaited<ReturnType<typeof proofDatabase>>;
