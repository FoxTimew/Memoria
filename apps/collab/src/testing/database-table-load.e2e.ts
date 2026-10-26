import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { freemem } from 'node:os';
import { writeFile } from 'node:fs/promises';
import { accessRequests, readDatabaseLimits } from '@memoria/db';
import { cellFixture } from './database-cell-fixture.ts';

// Closed SQL proof of the ADR008 physical design, not a public filter/compiler endpoint.
const f = await cellFixture(),
  { db } = f,
  limits = readDatabaseLimits();
const p95 = (v: number[]) => [...v].sort((a, b) => a - b)[Math.ceil(v.length * 0.95) - 1]!;
type Cursor = {
  missing: boolean;
  number: string | null;
  textMissing: boolean;
  text: string | null;
  id: string;
};
const reports: {
  role: string;
  scenario: string;
  series: number;
  freeBytes: number;
  power: unknown;
  samples: number[];
  p95: number;
}[] = [];
const plans: unknown[] = [];
const functionalOnly = process.env.MEMORIA_DATABASE_TABLE_SMOKE === 'true';
try {
  assert.equal(limits.rowsPerBase, 10000);
  assert.equal(limits.propertiesPerBase, 50);
  const rowIds = [...f.rows.slice(0, 2), ...Array.from({ length: 9998 }, () => randomUUID())];
  const targetIds = [...f.rows.slice(2), ...Array.from({ length: 48 }, () => randomUUID())];
  for (const [base, values] of [
    [f.bases[0]!, rowIds.slice(2)],
    [f.bases[1]!, targetIds.slice(2)],
  ] as const) {
    await db.pool.query(
      "INSERT INTO pages(id,workspace_id,kind,position,title) SELECT id,$1,'database_row','a0','Row '||n FROM unnest($2::uuid[]) WITH ORDINALITY t(id,n)",
      [db.workspace, values],
    );
    await db.pool.query(
      'INSERT INTO database_rows(workspace_id,database_id,page_id) SELECT $1,$2,id FROM unnest($3::uuid[]) t(id)',
      [db.workspace, base, values],
    );
  }
  const people = (
    await db.pool.query<{ id: string }>(
      'SELECT id FROM workspace_members WHERE workspace_id=$1 ORDER BY id',
      [db.workspace],
    )
  ).rows.map((r) => r.id);
  for (let n = people.length; n < 20; n++) {
    const user = randomUUID(),
      member = randomUUID();
    people.push(member);
    await db.pool.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Person fixture',$2,true)",
      [user, user + '@example.test'],
    );
    await db.pool.query(
      "INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,'member')",
      [member, db.workspace, user],
    );
  }
  await db.pool.query(
    'INSERT INTO database_assignable_people(workspace_id,database_id,person_id) VALUES($1,$2,$3)',
    [db.workspace, f.bases[0], people[0]],
  );
  const kinds = [
    'text',
    'number',
    'select',
    'multi_select',
    'date',
    'checkbox',
    'person',
    'relation',
    'url',
  ];
  for (let n = 10; n < 50; n++) {
    const kind = kinds[n % kinds.length]!,
      id = randomUUID();
    await db.pool.query(
      "INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position,config,relation_target_database_id) VALUES($1,$2,$3,$4,$4,$5,'a0',$6,$7)",
      [
        id,
        db.workspace,
        f.bases[0],
        'extra' + n,
        kind,
        JSON.stringify({ mode: 'date' }),
        kind === 'relation' ? f.bases[1] : null,
      ],
    );
  }
  const properties = (
    await db.pool.query<{ id: string; kind: string; config: { mode?: string } }>(
      'SELECT id,kind,config FROM database_properties WHERE database_id=$1 ORDER BY id',
      [f.bases[0]],
    )
  ).rows;
  for (const prop of properties) {
    let choices: string[] = [];
    if (prop.kind === 'select' || prop.kind === 'multi_select') {
      choices = (
        await db.pool.query<{ id: string }>(
          'SELECT id FROM property_options WHERE property_id=$1 ORDER BY id',
          [prop.id],
        )
      ).rows.map((r) => r.id);
      const extra = Array.from({ length: 100 - choices.length }, () => randomUUID());
      choices.push(...extra);
      await db.pool.query(
        "INSERT INTO property_options(id,workspace_id,database_id,property_id,kind,label,position) SELECT id,$1,$2,$3,$4,'Option '||n,'a0' FROM unnest($5::uuid[]) WITH ORDINALITY t(id,n)",
        [db.workspace, f.bases[0], prop.id, prop.kind, extra],
      );
    }
    if (prop.kind === 'person') choices = people;
    if (prop.kind === 'relation') choices = targetIds;
    const parameters = [rowIds, db.workspace, f.bases[0], prop.id, prop.kind, choices];
    const source =
      'WITH source AS (SELECT id,n,$6::uuid[] AS choices FROM unnest($1::uuid[]) WITH ORDINALITY t(id,n) WHERE n%17<>0) ';
    const columns = 'workspace_id,database_id,row_page_id,property_id,kind';
    const values = '$2,$3,id,$4,$5';
    let sql: string;
    if (['multi_select', 'person', 'relation'].includes(prop.kind)) {
      const table =
        prop.kind === 'multi_select'
          ? 'multi_select_values'
          : prop.kind === 'person'
            ? 'person_values'
            : 'relation_values';
      const field =
        prop.kind === 'multi_select'
          ? 'option_id'
          : prop.kind === 'person'
            ? 'member_id'
            : 'target_page_id';
      const maximum = prop.kind === 'relation' ? 50 : 20;
      sql =
        source +
        `INSERT INTO ${table}(${columns},${field}${prop.kind === 'relation' ? ',target_database_id' : ''}) SELECT ${values},choices[1+((n+j)%cardinality(choices))]${prop.kind === 'relation' ? ',$7' : ''} FROM source CROSS JOIN LATERAL generate_series(0,CASE WHEN n%1000=0 THEN ${maximum - 1} ELSE 0 END) j`;
      if (prop.kind === 'relation') parameters.push(f.bases[1]!);
    } else {
      let field: string, expression: string;
      switch (prop.kind) {
        case 'text':
          field = 'text_value';
          expression = "'Item '||n";
          break;
        case 'url':
          field = 'text_value';
          expression = "'https://example.test/'||n";
          break;
        case 'number':
          field = 'number_value';
          expression = 'n%1000';
          break;
        case 'checkbox':
          field = 'boolean_value';
          expression = 'n%2=0';
          break;
        case 'select':
          field = 'option_id';
          expression = 'choices[1+(n%100)]';
          break;
        case 'date':
          if (prop.config.mode === 'instant') {
            field = 'date_time_start,time_zone';
            expression =
              "timestamptz '2026-01-01T00:00:00Z'+(n%365)*interval '1 day','Europe/Paris'";
          } else {
            field = 'date_start';
            expression = "date '2026-01-01'+(n%365)::integer";
          }
          break;
        default:
          throw new Error('Unexpected fixture property');
      }
      sql =
        source +
        `INSERT INTO property_values(${columns},${field}) SELECT ${values},${expression} FROM source`;
    }
    await db.pool.query(sql, parameters);
    await db.pool.query(
      'INSERT INTO database_cell_versions(workspace_id,database_id,row_page_id,property_id,version) SELECT $1,$2,id,$3,1 FROM unnest($4::uuid[]) WITH ORDINALITY t(id,n) WHERE n%17<>0',
      [db.workspace, f.bases[0], prop.id, rowIds],
    );
  }
  await db.pool.query('UPDATE pages SET deleted_at=now() WHERE id=$1', [targetIds[49]]);
  await db.pool.query('ANALYZE');
  console.log(
    JSON.stringify({
      fixture: {
        rows: rowIds.length,
        properties: properties.length,
        relationTargets: targetIds.length,
        people: people.length,
        optionsPerProperty: 100,
        holes: 'n % 17',
        fullSets: 'n % 1000',
      },
      limits: { server: 200, pageSize: 50 },
    }),
  );
  const c = await db.pool.connect();
  const query = async (
    role: 'owner' | 'guest',
    scenario: string,
    cursor?: Cursor,
    offset = 0,
    explain = false,
  ) => {
    const subject = role === 'owner' ? f.owner : f.guest;
    await c.query('BEGIN');
    try {
      await c.query("SET LOCAL statement_timeout='2s'");
      await c.query(
        'SELECT id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [db.workspace, f.bases],
      );
      const allowed = (
        await c.query<{ key: string; role: string }>(
          'SELECT key,role FROM content_resolve_access($1::jsonb)',
          [accessRequests(f.containers.map((page, i) => ({ ...subject, key: String(i), page })))],
        )
      ).rows;
      assert(allowed.some((r) => r.key === '0'));
      const targetAllowed = allowed.some((r) => r.key === '1');
      const args: unknown[] = [];
      const param = (v: unknown) => {
        args.push(v);
        return '$' + args.length;
      };
      const w = param(db.workspace),
        base = param(f.bases[0]);
      const number = param(f.properties.number),
        text = param(f.properties.text);
      const descending = scenario === 'nulls-desc',
        sign = descending ? '-' : '';
      const order = `(nv.number_value IS NULL),${sign}nv.number_value,(tv.text_value IS NULL),lower(tv.text_value) COLLATE "C",p.id`;
      const where = [
        `r.workspace_id=${w} AND r.database_id=${base} AND r.deleted_at IS NULL AND p.deleted_at IS NULL`,
      ];
      if (scenario !== 'nulls-desc')
        where.push(`position(${param('item')} in lower(tv.text_value))>0`, `nv.number_value>=0`);
      if (scenario === 'ten-filters') {
        where.push('nv.number_value<=200');
        for (const [kind, clause] of [
          ['checkbox', 'v.boolean_value=true'],
          [
            'select',
            `v.option_id IN(SELECT id FROM property_options WHERE property_id=${param(f.properties.select)} ORDER BY id LIMIT 20)`,
          ],
          ['date', "v.date_start BETWEEN date '2026-01-01' AND date '2026-12-31'"],
          ['url', "position('/' in v.text_value)>0"],
        ])
          where.push(
            `EXISTS(SELECT 1 FROM property_values v WHERE v.workspace_id=${w} AND v.row_page_id=p.id AND v.property_id=${param(f.properties[kind!])} AND v.deleted_at IS NULL AND ${clause})`,
          );
        where.push(
          `EXISTS(SELECT 1 FROM multi_select_values v WHERE v.workspace_id=${w} AND v.row_page_id=p.id AND v.property_id=${param(f.properties.multi_select)} AND v.deleted_at IS NULL)`,
        );
        where.push(
          `EXISTS(SELECT 1 FROM person_values v JOIN database_people dp ON dp.workspace_id=v.workspace_id AND dp.id=v.member_id JOIN workspace_members m ON m.id=dp.member_id WHERE v.workspace_id=${w} AND v.row_page_id=p.id AND v.property_id=${param(f.properties.person)} AND v.deleted_at IS NULL AND (${param(role !== 'guest')} OR m.user_id=${param(subject.user)} OR EXISTS(SELECT 1 FROM database_assignable_people a WHERE a.workspace_id=${w} AND a.database_id=${base} AND a.person_id=dp.id)))`,
        );
        where.push(
          `${targetAllowed ? '' : 'NOT '}EXISTS(SELECT 1 FROM relation_values v JOIN pages t ON t.workspace_id=v.workspace_id AND t.id=v.target_page_id JOIN database_rows tr ON tr.workspace_id=v.workspace_id AND tr.page_id=t.id WHERE v.workspace_id=${w} AND v.row_page_id=p.id AND v.property_id=${param(f.properties.relation)} AND v.deleted_at IS NULL AND t.deleted_at IS NULL AND tr.deleted_at IS NULL AND ${param(targetAllowed)})`,
        );
      }
      if (cursor)
        where.push(
          `ROW((nv.number_value IS NULL)::int,coalesce(${sign}nv.number_value,0),(tv.text_value IS NULL)::int,coalesce(lower(tv.text_value),'') COLLATE "C",p.id)>ROW(${param(Number(cursor.missing))}::int,${param(cursor.number ?? '0')}::numeric,${param(Number(cursor.textMissing))}::int,${param(cursor.text ?? '')}::text COLLATE "C",${param(cursor.id)}::uuid)`,
        );
      const sql = `SELECT p.id,p.title,(nv.number_value IS NULL) AS missing,(${sign}nv.number_value)::text AS number,(tv.text_value IS NULL) AS "textMissing",lower(tv.text_value) AS text FROM database_rows r JOIN pages p ON p.workspace_id=r.workspace_id AND p.id=r.page_id LEFT JOIN property_values nv ON nv.workspace_id=r.workspace_id AND nv.row_page_id=r.page_id AND nv.property_id=${number} AND nv.deleted_at IS NULL LEFT JOIN property_values tv ON tv.workspace_id=r.workspace_id AND tv.row_page_id=r.page_id AND tv.property_id=${text} AND tv.deleted_at IS NULL WHERE ${where.join(' AND ')} ORDER BY ${order} LIMIT ${offset ? 1 : 51}${offset ? ' OFFSET ' + offset : ''}`;
      if (explain)
        plans.push({
          role,
          scenario,
          plan: (await c.query('EXPLAIN(ANALYZE,BUFFERS,FORMAT JSON) ' + sql, args)).rows,
        });
      const selected = (await c.query<Cursor & { title: string }>(sql, args)).rows;
      const page = selected.slice(0, 50),
        ids = page.map((r) => r.id);
      const scalar = (
        await c.query(
          'SELECT row_page_id,property_id,kind,text_value,number_value::text,boolean_value,option_id,date_start::text,date_time_start::text,time_zone FROM property_values WHERE workspace_id=$1 AND row_page_id=ANY($2::uuid[]) AND deleted_at IS NULL',
          [db.workspace, ids],
        )
      ).rows;
      const multi = (
        await c.query(
          'SELECT row_page_id,property_id,jsonb_agg(option_id ORDER BY option_id) AS items FROM multi_select_values WHERE workspace_id=$1 AND row_page_id=ANY($2::uuid[]) AND deleted_at IS NULL GROUP BY row_page_id,property_id',
          [db.workspace, ids],
        )
      ).rows;
      const person = (
        await c.query(
          `SELECT v.row_page_id,v.property_id,bool_or(m.id IS NULL OR NOT ($3 OR m.user_id=$4 OR a.person_id IS NOT NULL)) AS "hasHidden",coalesce(jsonb_agg(jsonb_build_object('id',m.id,'name',u.name)) FILTER(WHERE m.id IS NOT NULL AND ($3 OR m.user_id=$4 OR a.person_id IS NOT NULL)),'[]') AS items FROM person_values v LEFT JOIN database_people dp ON dp.workspace_id=v.workspace_id AND dp.id=v.member_id LEFT JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id LEFT JOIN auth_users u ON u.id=m.user_id LEFT JOIN database_assignable_people a ON a.workspace_id=v.workspace_id AND a.database_id=v.database_id AND a.person_id=dp.id WHERE v.workspace_id=$1 AND v.row_page_id=ANY($2::uuid[]) AND v.deleted_at IS NULL GROUP BY v.row_page_id,v.property_id`,
          [db.workspace, ids, role !== 'guest', subject.user],
        )
      ).rows;
      const relation = (
        await c.query(
          `SELECT v.row_page_id,v.property_id,bool_or(NOT $3 OR p.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL) AS "hasHidden",coalesce(jsonb_agg(jsonb_build_object('id',p.id,'title',p.title)) FILTER(WHERE $3 AND p.deleted_at IS NULL AND r.deleted_at IS NULL),'[]') AS items FROM relation_values v JOIN pages p ON p.workspace_id=v.workspace_id AND p.id=v.target_page_id JOIN database_rows r ON r.workspace_id=v.workspace_id AND r.page_id=p.id WHERE v.workspace_id=$1 AND v.row_page_id=ANY($2::uuid[]) AND v.deleted_at IS NULL GROUP BY v.row_page_id,v.property_id`,
          [db.workspace, ids, targetAllowed],
        )
      ).rows;
      const versions = (
        await c.query(
          'SELECT row_page_id,property_id,version::text FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=ANY($2::uuid[])',
          [db.workspace, ids],
        )
      ).rows;
      const output = {
        rows: page.map(({ id, title }) => ({ id, title })),
        scalar,
        multi,
        person,
        relation,
        versions,
        hasMore: selected.length > 50,
      };
      const serialized = JSON.stringify(output);
      assert(Buffer.byteLength(serialized) <= limits.responseBytes);
      if (role === 'guest') {
        for (const target of targetIds)
          assert(!serialized.includes(target), 'hidden relation ID in table payload');
      }
      await c.query('COMMIT');
      return { cursor: page.at(-1), count: page.length };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    }
  };
  try {
    for (const role of ['owner', 'guest'] as const)
      for (const scenario of ['broad', 'deep', 'ten-filters', 'nulls-desc']) {
        const cursor =
          scenario === 'deep' ? (await query(role, 'broad', undefined, 9000)).cursor : undefined;
        if (scenario === 'deep') assert(cursor, 'deep keyset anchor must exist');
        if (functionalOnly) {
          const result = await query(role, scenario, cursor);
          assert(result.count > 0 && result.count <= 50, 'fixture must exercise a populated page');
          console.log(
            JSON.stringify({
              role,
              scenario,
              count: result.count,
              status: 'FUNCTIONAL_ONLY_NO_MEASUREMENT',
            }),
          );
          continue;
        }
        for (let series = 1; series <= 3; series++) {
          const power = JSON.parse(
            execFileSync(process.execPath, ['scripts/measurement-power.mjs'], {
              encoding: 'utf8',
              windowsHide: true,
            }),
          );
          const freeBytes = freemem();
          console.log(JSON.stringify({ role, scenario, series, power, freeBytes }));
          assert(power.allowed, 'AC_POWER_REQUIRED');
          assert(freeBytes >= 3 * 1024 ** 3, 'FREE_RAM_BELOW_3_GIB');
          // Warm separately; EXPLAIN is diagnostic and not part of a timed sample.
          for (let n = 0; n < 3; n++)
            await query(role, scenario, cursor, 0, series === 1 && n === 0);
          const samples: number[] = [];
          for (let n = 0; n < 200; n++) {
            const start = performance.now();
            await query(role, scenario, cursor);
            samples.push(performance.now() - start);
          }
          reports.push({ role, scenario, series, power, freeBytes, samples, p95: p95(samples) });
          await writeFile(
            '.local/session-6a-table-measurement.json',
            JSON.stringify(
              {
                fixture: {
                  rows: 10000,
                  properties: 50,
                  types: 9,
                  options: 100,
                  relationTargets: 50,
                  people: 20,
                  pageSize: 50,
                },
                protocol:
                  'Closed SQL query proof, kernel entry to JSON serialization and commit; no HTTP or signed-cursor codec (6b)',
                reports,
                plans,
              },
              null,
              2,
            ) + '\n',
          );
          console.log(JSON.stringify({ role, scenario, series, p95: p95(samples) }));
        }
        const median = reports
          .filter((r) => r.role === role && r.scenario === scenario)
          .map((r) => r.p95)
          .sort((a, b) => a - b)[1]!;
        console.log(
          JSON.stringify({ role, scenario, medianP95: median, limit: 200, passed: median < 200 }),
        );
        assert(median < 200, 'STOP_6A_TABLE_BUDGET');
      }
  } finally {
    c.release();
  }
} finally {
  await db.close();
}
