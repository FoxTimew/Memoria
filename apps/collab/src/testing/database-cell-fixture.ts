import { randomUUID } from 'node:crypto';
import { DatabaseCells } from '@memoria/db';
import { testDatabase } from './database.ts';

export async function cellFixture() {
  const db = await testDatabase();
  const { pool, workspace, page, user, session } = db;
  const bases = [randomUUID(), randomUUID()],
    containers = [page, randomUUID()];
  const rows = Array.from({ length: 4 }, () => randomUUID());
  const properties: Record<string, string> = {},
    options: Record<string, string[]> = {};
  const guestUser = randomUUID(),
    guestSession = randomUUID(),
    guestMember = randomUUID(),
    guestSubject = randomUUID(),
    grant = randomUUID();
  await pool.query(
    "INSERT INTO pages(id,workspace_id,position,title) VALUES($1,$2,'a1','Hidden base')",
    [containers[1], workspace],
  );
  for (let i = 0; i < 2; i++)
    await pool.query('INSERT INTO databases(id,workspace_id,page_id) VALUES($1,$2,$3)', [
      bases[i],
      workspace,
      containers[i],
    ]);
  for (let i = 0; i < 4; i++) {
    await pool.query(
      "INSERT INTO pages(id,workspace_id,kind,position,title) VALUES($1,$2,'database_row','a0',$3)",
      [rows[i], workspace, 'Row ' + i],
    );
    await pool.query(
      'INSERT INTO database_rows(workspace_id,database_id,page_id) VALUES($1,$2,$3)',
      [workspace, bases[i < 2 ? 0 : 1], rows[i]],
    );
  }
  for (const kind of [
    'text',
    'number',
    'checkbox',
    'url',
    'date',
    'instant',
    'select',
    'multi_select',
    'relation',
    'person',
  ]) {
    const id = randomUUID();
    properties[kind] = id;
    await pool.query(
      "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position,config,relation_target_database_id) VALUES($1,$2,$3,$4,$4,$5,'a0',$6,$7)",
      [
        id,
        workspace,
        bases[0],
        kind,
        kind === 'instant' ? 'date' : kind,
        JSON.stringify({ mode: kind === 'instant' ? 'instant' : 'date' }),
        kind === 'relation' ? bases[1] : null,
      ],
    );
    if (kind === 'select' || kind === 'multi_select') {
      options[kind] = [randomUUID(), randomUUID()];
      for (const option of options[kind]!)
        await pool.query(
          "INSERT INTO property_options(id,workspace_id,database_id,property_id,kind,label,position) VALUES($1,$2,$3,$4,$5,'Choice','a0')",
          [option, workspace, bases[0], id, kind],
        );
    }
  }
  await pool.query(
    "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Guest fixture',$2,true)",
    [guestUser, guestUser + '@example.test'],
  );
  await pool.query(
    "INSERT INTO auth_sessions(id,user_id,token,expires_at) VALUES($1,$2,$3,now()+interval '1 hour')",
    [guestSession, guestUser, randomUUID()],
  );
  await pool.query(
    "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'guest')",
    [guestMember, workspace, guestUser],
  );
  await pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
    workspace,
    guestUser,
  ]);
  await pool.query(
    "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3)",
    [guestSubject, workspace, guestMember],
  );
  await pool.query(
    "INSERT INTO access_grants(id,workspace_id,subject_id,resource_id,level,inherit) VALUES($1,$2,$3,$4,'edit',true)",
    [grant, workspace, guestSubject, page],
  );
  const owner = { user, session, workspace },
    guest = { user: guestUser, session: guestSession, workspace };
  const cells = new DatabaseCells(pool);
  const address = (kind: string, row = rows[0]!) => ({
    database: bases[0]!,
    row,
    property: properties[kind]!,
  });
  return {
    db,
    bases,
    rows,
    containers,
    properties,
    options,
    owner,
    guest,
    guestMember,
    guestSubject,
    grant,
    cells,
    address,
  };
}
