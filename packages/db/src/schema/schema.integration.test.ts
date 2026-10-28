import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import pg from 'pg';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe.skipIf(!process.env.TEST_DATABASE_URL)('PostgreSQL schema invariants', () => {
  const schema = `memoria_test_${randomUUID().replaceAll('-', '')}`;
  const pool = new pg.Client({ connectionString: process.env.TEST_DATABASE_URL });
  const workspaceA = randomUUID();
  const workspaceB = randomUUID();
  let initialized = false;

  beforeAll(async () => {
    await pool.connect();
    await pool.query(`CREATE SCHEMA "${schema}"`);
    initialized = true;
    await pool.query(`SET search_path TO "${schema}"`);
    const folder = fileURLToPath(new URL('../../drizzle/', import.meta.url));
    for (const file of readdirSync(folder)
      .filter((path) => path.endsWith('.sql'))
      .sort()) {
      const migration = readFileSync(`${folder}/${file}`, 'utf8').replaceAll(
        '"public".',
        `"${schema}".`,
      );
      await pool.query(migration);
    }
    await pool.query('INSERT INTO workspaces (id,name,slug) VALUES ($1,$2,$3),($4,$5,$6)', [
      workspaceA,
      'A',
      workspaceA,
      workspaceB,
      'B',
      workspaceB,
    ]);
  }, 30000);

  afterAll(async () => {
    if (initialized && /^memoria_test_[a-f0-9]{32}$/.test(schema))
      await pool.query(`DROP SCHEMA "${schema}" CASCADE`);
    await pool.end();
  });

  const page = async (workspace: string, position: string, parent: string | null = null) => {
    const id = randomUUID();
    await pool.query(
      'INSERT INTO pages (id,workspace_id,parent_id,position) VALUES ($1,$2,$3,$4)',
      [id, workspace, parent, position],
    );
    return id;
  };

  it('rejects page parents from another workspace', async () => {
    const parent = await page(workspaceB, 'a0');
    await expect(page(workspaceA, 'a0', parent)).rejects.toMatchObject({ code: '23503' });
  });

  it('enforces root ordering uniqueness but allows reusing archived positions', async () => {
    const first = await page(workspaceA, 'b00');
    await expect(page(workspaceA, 'b00')).rejects.toMatchObject({ code: '23505' });
    await pool.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [first]);
    await expect(page(workspaceA, 'b00')).resolves.toBeTypeOf('string');
  });

  it('rejects block parents from another page', async () => {
    const firstPage = await page(workspaceA, 'b01');
    const secondPage = await page(workspaceA, 'b02');
    const block = randomUUID();
    await pool.query(
      "INSERT INTO blocks (id,workspace_id,page_id,position,type,schema_version,content) VALUES ($1,$2,$3,'a0','core.paragraph',1,'{}')",
      [block, workspaceA, firstPage],
    );
    await expect(
      pool.query(
        "INSERT INTO blocks (workspace_id,page_id,parent_id,position,type,schema_version,content) VALUES ($1,$2,$3,'a0','core.paragraph',1,'{}')",
        [workspaceA, secondPage, block],
      ),
    ).rejects.toMatchObject({ code: '23503' });
  });

  it('rejects cyclic page moves', async () => {
    const root = await page(workspaceA, 'b03');
    const child = await page(workspaceA, 'a0', root);
    await expect(
      pool.query('UPDATE pages SET parent_id=$1 WHERE id=$2', [child, root]),
    ).rejects.toMatchObject({ code: '23514' });
  });

  it('rejects scalar values with an incompatible property type', async () => {
    const host = await page(workspaceA, 'b04');
    const row = randomUUID();
    await pool.query(
      "INSERT INTO pages(id,workspace_id,kind,position) VALUES($1,$2,'database_row','a0')",
      [row, workspaceA],
    );
    const database = randomUUID();
    const property = randomUUID();
    await pool.query('INSERT INTO databases (id,workspace_id,page_id) VALUES ($1,$2,$3)', [
      database,
      workspaceA,
      host,
    ]);
    await pool.query(
      'INSERT INTO database_rows (workspace_id,database_id,page_id) VALUES ($1,$2,$3)',
      [workspaceA, database, row],
    );
    await pool.query(
      "INSERT INTO database_properties (id,workspace_id,database_id,key,name,kind,position) VALUES ($1,$2,$3,'score','Score','number','a0')",
      [property, workspaceA, database],
    );
    await expect(
      pool.query(
        "INSERT INTO property_values (workspace_id,database_id,row_page_id,property_id,kind,text_value) VALUES ($1,$2,$3,$4,'text','wrong')",
        [workspaceA, database, row, property],
      ),
    ).rejects.toMatchObject({ code: '23503' });
    await expect(
      pool.query(
        "INSERT INTO property_values (workspace_id,database_id,row_page_id,property_id,kind,text_value) VALUES ($1,$2,$3,$4,'number','wrong')",
        [workspaceA, database, row, property],
      ),
    ).rejects.toMatchObject({ code: '23514' });
    await pool.query(
      "INSERT INTO property_values (workspace_id,database_id,row_page_id,property_id,kind,number_value) VALUES ($1,$2,$3,$4,'number',3.5)",
      [workspaceA, database, row, property],
    );
  });

  it('generates a searchable tsvector in PostgreSQL', async () => {
    const id = await page(workspaceA, 'b05');
    await pool.query(
      'INSERT INTO search_documents (workspace_id,page_id,plain_text,page_version) VALUES ($1,$2,$3,1)',
      [workspaceA, id, 'Dialogue forêt character'],
    );
    const result = await pool.query<{ found: boolean }>(
      "SELECT vector @@ plainto_tsquery('simple','character') AS found FROM search_documents WHERE page_id=$1",
      [id],
    );
    expect(result.rows[0]?.found).toBe(true);
  });
});
