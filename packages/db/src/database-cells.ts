import type { Pool, PoolClient } from 'pg';
import { accessRequests, resolvePageAccess } from './access.ts';
import type { PageAccessRequest } from './access.ts';
import { readDatabaseLimits } from './database-limits.ts';
import type { DatabaseLimits } from './database-limits.ts';

/** Transaction kernel used by 6a proofs. HTTP admission/quotas and full CRUD follow in 6b. */
export type DatabaseSubject = { user: string; session: string; workspace: string };
export type CellAddress = { database: string; row: string; property: string };
export type CellWrite = CellAddress & {
  expectedCellVersion: string;
  expectedSchemaVersion: string;
  value: unknown;
};
export class DatabaseFault extends Error {
  constructor(
    public status: number,
    public code: string,
    public current?: unknown,
  ) {
    super(code);
  }
}
type Property = {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  relation_target_database_id: string | null;
};
type Delta = { add: string[]; remove: string[]; clearVisible: boolean };
type Reference = { id: string; name?: string; title?: string };
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
function fail(code = 'INVALID_CELL', status = 400): never {
  throw new DatabaseFault(status, code);
}
const civilDate = (v: string) =>
  /^\d{4}-\d{2}-\d{2}$/.test(v) &&
  Number.isFinite(Date.parse(v)) &&
  new Date(v).toISOString().slice(0, 10) === v;
const identifiers = (...ids: string[]) => {
  if (ids.some((id) => !uuid.test(id))) fail();
};
const version = (v: string) => {
  if (!/^(0|[1-9][0-9]{0,18})$/.test(v) || BigInt(v) > 9223372036854775806n) fail();
  return v;
};
function ids(value: unknown, max: number): string[] {
  if (
    !Array.isArray(value) ||
    value.length > max ||
    value.some((x) => typeof x !== 'string' || !uuid.test(x))
  )
    fail();
  const result = value as string[];
  if (new Set(result).size !== result.length) fail();
  return [...result].sort();
}
function delta(value: unknown, max: number): Delta {
  if (!value || typeof value !== 'object' || Array.isArray(value)) fail();
  const v = value as Record<string, unknown>;
  if (
    Object.keys(v).some((k) => !['add', 'remove', 'clearVisible'].includes(k)) ||
    (v.clearVisible !== undefined && typeof v.clearVisible !== 'boolean')
  )
    fail();
  const add = ids(v.add ?? [], max),
    remove = ids(v.remove ?? [], max);
  if (add.some((id) => remove.includes(id))) fail();
  return { add, remove, clearVisible: v.clearVisible === true };
}

export class DatabaseCells {
  constructor(
    readonly pool: Pool,
    readonly limits: DatabaseLimits = readDatabaseLimits(),
  ) {}
  private request(subject: DatabaseSubject, a: CellAddress): PageAccessRequest {
    return { ...subject, key: a.row, page: a.row, rowScope: { database: a.database } };
  }
  private async transaction<T>(work: (c: PoolClient) => Promise<T>): Promise<T> {
    const c = await this.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query("SET LOCAL lock_timeout='5s'");
      const result = await work(c);
      await c.query('COMMIT');
      return result;
    } catch (error) {
      await c.query('ROLLBACK');
      if (error instanceof DatabaseFault) throw error;
      const code = (error as { code?: string }).code;
      if (code && ['23503', '23514', '23505', '22P02', '22003', '22007', '22008'].includes(code))
        fail();
      if (code && ['40P01', '55P03', '57014'].includes(code)) fail('RETRY_REQUIRED', 409);
      throw error;
    } finally {
      c.release();
    }
  }
  private async access(c: PoolClient, s: DatabaseSubject, a: CellAddress, edit = false) {
    const result = (await resolvePageAccess(c, [this.request(s, a)])).get(a.row);
    if (!result || (edit && result.level !== 'edit')) fail('ACCESS_DENIED', 404);
    return result;
  }
  private async property(c: PoolClient, s: DatabaseSubject, a: CellAddress) {
    const p = (
      await c.query<Property>(
        'SELECT id,kind,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND id=$3 AND deleted_at IS NULL',
        [s.workspace, a.database, a.property],
      )
    ).rows[0];
    if (!p) fail('ACCESS_DENIED', 404);
    return p;
  }
  private async schema(c: PoolClient, s: DatabaseSubject, a: CellAddress) {
    const b = (
      await c.query<{ schema_version: string }>(
        'SELECT schema_version::text FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
        [s.workspace, a.database],
      )
    ).rows[0];
    if (!b) fail('ACCESS_DENIED', 404);
    return b.schema_version;
  }
  /** Plan relation latches from immutable candidates, then re-read under cell lock.
   * If another cell writer changed the set, retry the whole lock plan, never acquire rows out of order. */
  private async plan(c: PoolClient, s: DatabaseSubject, a: CellAddress, value?: unknown) {
    const preliminary = (
      await c.query<Property>(
        'SELECT id,kind,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND id=$3',
        [s.workspace, a.database, a.property],
      )
    ).rows[0];
    const before =
      preliminary?.kind === 'relation'
        ? (
            await c.query<{ target_page_id: string }>(
              'SELECT target_page_id FROM relation_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL ORDER BY target_page_id',
              [s.workspace, a.row, a.property],
            )
          ).rows.map((r) => r.target_page_id)
        : [];
    const change =
      value !== undefined && preliminary?.kind === 'relation'
        ? delta(value, this.limits.relationValues)
        : null;
    const bases = [
      a.database,
      ...(preliminary?.relation_target_database_id
        ? [preliminary.relation_target_database_id]
        : []),
    ].sort();
    await c.query(
      'SELECT id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
      [s.workspace, bases],
    );
    const rows = [
      ...new Set([a.row, ...before, ...(change?.add ?? []), ...(change?.remove ?? [])]),
    ].sort();
    // All base latches precede ALL row latches, including hidden/current relation targets.
    await c.query(
      'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND database_id=ANY($2::uuid[]) AND page_id=ANY($3::uuid[]) ORDER BY page_id FOR SHARE',
      [s.workspace, bases, rows],
    );
    return { preliminary, before };
  }
  private async references(
    c: PoolClient,
    s: DatabaseSubject,
    a: CellAddress,
    p: Property,
    requested: string[],
  ) {
    if (!requested.length) return new Map<string, Reference>();
    if (p.kind === 'relation') {
      const requests = requested.map((id) => ({
        ...s,
        key: id,
        page: id,
        rowScope: { database: p.relation_target_database_id! },
      }));
      const access = await resolvePageAccess(c, requests);
      const names = (
        await c.query<{ id: string; title: string }>(
          'SELECT id,title FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
          [s.workspace, [...access.keys()]],
        )
      ).rows;
      return new Map(names.map((row) => [row.id, row]));
    }
    const values = (
      await c.query<{ id: string; name: string }>(
        `SELECT dp.id,u.name FROM database_people dp JOIN workspace_members m ON m.id=dp.member_id AND m.workspace_id=dp.workspace_id JOIN auth_users u ON u.id=m.user_id
      JOIN workspace_members viewer ON viewer.workspace_id=m.workspace_id AND viewer.user_id=$3
      WHERE dp.workspace_id=$1 AND dp.id=ANY($2::uuid[]) AND (viewer.role<>'guest' OR m.id=viewer.id OR EXISTS(SELECT 1 FROM database_assignable_people ap WHERE ap.workspace_id=$1 AND ap.database_id=$4 AND ap.person_id=dp.id))`,
        [s.workspace, requested, s.user, a.database],
      )
    ).rows;
    return new Map(values.map((row) => [row.id, row]));
  }
  private async value(c: PoolClient, s: DatabaseSubject, a: CellAddress, p: Property) {
    const args = [s.workspace, a.row, a.property];
    if (p.kind === 'files') {
      const rows = (
        await c.query<{ id: string; name: string; visible: boolean }>(
          `SELECT f.id,f.original_name AS name,(f.state='ready' AND f.deleted_at IS NULL) AS visible
         FROM file_usages u JOIN files f ON f.workspace_id=u.workspace_id AND f.id=u.file_id
         WHERE u.workspace_id=$1 AND u.page_id=$2 AND u.slot_kind='cell' AND u.slot_id=$3 ORDER BY f.id`,
          args,
        )
      ).rows;
      return {
        items: rows.filter((r) => r.visible).map(({ id, name }) => ({ id, name })),
        hasHidden: rows.some((r) => !r.visible),
      };
    }
    if (p.kind === 'relation' || p.kind === 'person') {
      const query =
        p.kind === 'relation'
          ? 'SELECT target_page_id AS id FROM relation_values'
          : 'SELECT member_id AS id FROM person_values';
      const values = (
        await c.query<{ id: string }>(
          query +
            ' WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL ORDER BY id',
          args,
        )
      ).rows.map((r) => r.id);
      const visible = await this.references(c, s, a, p, values);
      return { items: [...visible.values()], hasHidden: visible.size !== values.length };
    }
    if (p.kind === 'multi_select')
      return (
        await c.query<{ option_id: string }>(
          'SELECT option_id FROM multi_select_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL ORDER BY option_id',
          args,
        )
      ).rows.map((r) => r.option_id);
    const row = (
      await c.query(
        `SELECT text_value,number_value::text,boolean_value,option_id,date_start::text,date_end::text,date_time_start::text,date_time_end::text,time_zone FROM property_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL`,
        args,
      )
    ).rows[0];
    if (!row) return null;
    if (p.kind === 'text' || p.kind === 'url') return row.text_value;
    if (p.kind === 'number') return row.number_value;
    if (p.kind === 'checkbox') return row.boolean_value;
    if (p.kind === 'select') return row.option_id;
    return row.date_start
      ? { start: row.date_start, end: row.date_end }
      : {
          start: new Date(row.date_time_start).toISOString(),
          end: row.date_time_end ? new Date(row.date_time_end).toISOString() : null,
          timeZone: row.time_zone,
        };
  }
  async read(s: DatabaseSubject, a: CellAddress) {
    identifiers(s.workspace, a.database, a.row, a.property);
    return this.transaction(async (c) => {
      await this.access(c, s, a);
      const plan = await this.plan(c, s, a);
      await this.access(c, s, a);
      const p = await this.property(c, s, a);
      const schemaVersion = await this.schema(c, s, a);
      await c.query(
        'INSERT INTO database_cell_versions(workspace_id,database_id,row_page_id,property_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [s.workspace, a.database, a.row, a.property],
      );
      // Shared cell latch keeps value/version from being torn across SQL commands.
      const v =
        (
          await c.query<{ version: string }>(
            'SELECT version::text FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 FOR SHARE',
            [s.workspace, a.row, a.property],
          )
        ).rows[0]?.version ?? '0';
      if (p.kind === 'relation') {
        const actual = (
          await c.query<{ target_page_id: string }>(
            'SELECT target_page_id FROM relation_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL ORDER BY target_page_id',
            [s.workspace, a.row, a.property],
          )
        ).rows.map((r) => r.target_page_id);
        if (JSON.stringify(actual) !== JSON.stringify(plan.before)) fail('RETRY_REQUIRED', 409);
      }
      const value = await this.value(c, s, a, p);
      await this.access(c, s, a);
      return { version: v, schemaVersion, value };
    });
  }
  async write(s: DatabaseSubject, a: CellWrite) {
    return this.transaction((c) => this.writeInTransaction(c, s, a));
  }
  /** Internal composition for atomic row creation; callers pre-plan all base/row latches. */
  async writeInTransaction(c: PoolClient, s: DatabaseSubject, a: CellWrite) {
    identifiers(s.workspace, a.database, a.row, a.property);
    version(a.expectedCellVersion);
    version(a.expectedSchemaVersion);
    if (Buffer.byteLength(JSON.stringify(a)) > this.limits.mutationBytes) fail('VALUE_LIMIT');

    await this.access(c, s, a, true);
    const plan = await this.plan(c, s, a, a.value);
    await this.access(c, s, a, true);
    const schemaVersion = await this.schema(c, s, a);
    if (schemaVersion !== a.expectedSchemaVersion)
      throw new DatabaseFault(409, 'SCHEMA_VERSION_CONFLICT', { schemaVersion });
    const p = await this.property(c, s, a);
    if (
      p.kind !== plan.preliminary?.kind ||
      p.relation_target_database_id !== plan.preliminary?.relation_target_database_id
    )
      fail('RETRY_REQUIRED', 409);
    await c.query(
      'INSERT INTO database_cell_versions(workspace_id,database_id,row_page_id,property_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
      [s.workspace, a.database, a.row, a.property],
    );
    const current = (
      await c.query<{ version: string }>(
        'SELECT version::text FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 FOR UPDATE',
        [s.workspace, a.row, a.property],
      )
    ).rows[0]!.version;
    const access = await this.access(c, s, a, true);
    if (current !== a.expectedCellVersion)
      throw new DatabaseFault(409, 'CELL_VERSION_CONFLICT', {
        version: current,
        schemaVersion,
        value: await this.value(c, s, a, p),
      });
    if (p.kind === 'relation') {
      const actual = (
        await c.query<{ target_page_id: string }>(
          'SELECT target_page_id FROM relation_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL ORDER BY target_page_id',
          [s.workspace, a.row, a.property],
        )
      ).rows.map((r) => r.target_page_id);
      if (JSON.stringify(actual) !== JSON.stringify(plan.before)) fail('RETRY_REQUIRED', 409);
    }
    await this.replace(c, s, a, p, access.actor);
    const next = (BigInt(current) + 1n).toString();
    await c.query(
      'UPDATE database_cell_versions SET version=$1 WHERE workspace_id=$2 AND row_page_id=$3 AND property_id=$4',
      [next, s.workspace, a.row, a.property],
    );
    await c.query('SELECT database_mark_row($1,$2,$3,$4)', [
      s.workspace,
      a.database,
      a.row,
      access.actor,
    ]);
    await c.query('SELECT database_refresh_row($1,$2)', [s.workspace, a.row]);
    const value = await this.value(c, s, a, p);
    await this.access(c, s, a, true);
    return { version: next, schemaVersion, value };
  }
  private async replace(
    c: PoolClient,
    s: DatabaseSubject,
    a: CellWrite,
    p: Property,
    actor: string,
  ) {
    const args = [s.workspace, a.database, a.row, a.property, p.kind, actor];
    if (p.kind === 'relation' || p.kind === 'person') {
      const maximum = p.kind === 'relation' ? this.limits.relationValues : this.limits.setValues;
      const change = delta(a.value, maximum),
        table = p.kind === 'relation' ? 'relation_values' : 'person_values',
        column = p.kind === 'relation' ? 'target_page_id' : 'member_id';
      const existing = (
        await c.query<{ id: string }>(
          `SELECT ${column} AS id FROM ${table} WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND deleted_at IS NULL`,
          [s.workspace, a.row, a.property],
        )
      ).rows.map((r) => r.id);
      const visible = await this.references(c, s, a, p, [
        ...new Set([...existing, ...change.add, ...change.remove]),
      ]);
      if ([...change.add, ...change.remove].some((id) => !visible.has(id)))
        fail('REFERENCE_UNAVAILABLE', 400);
      const remove = change.clearVisible ? existing.filter((id) => visible.has(id)) : change.remove;
      const values = [
        ...new Set([...existing.filter((id) => !remove.includes(id)), ...change.add]),
      ];
      if (values.length > maximum) fail('VALUE_LIMIT');
      await c.query(
        `DELETE FROM ${table} WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 AND ${column}=ANY($4::uuid[])`,
        [s.workspace, a.row, a.property, remove],
      );
      for (const id of change.add.filter((id) => !existing.includes(id) || remove.includes(id))) {
        if (p.kind === 'relation')
          await c.query(
            'INSERT INTO relation_values(workspace_id,database_id,row_page_id,property_id,kind,created_by,updated_by,target_database_id,target_page_id) VALUES($1,$2,$3,$4,$5,$6,$6,$7,$8)',
            [...args, p.relation_target_database_id, id],
          );
        else
          await c.query(
            'INSERT INTO person_values(workspace_id,database_id,row_page_id,property_id,kind,created_by,updated_by,member_id) VALUES($1,$2,$3,$4,$5,$6,$6,$7)',
            [...args, id],
          );
      }
      return;
    }
    if (p.kind === 'multi_select') {
      const choices = ids(a.value ?? [], this.limits.setValues);
      await this.options(c, s, a, choices);
      await c.query(
        'DELETE FROM multi_select_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3',
        [s.workspace, a.row, a.property],
      );
      await c.query(
        'INSERT INTO multi_select_values(workspace_id,database_id,row_page_id,property_id,kind,created_by,updated_by,option_id) SELECT $1,$2,$3,$4,$5,$6,$6,id FROM unnest($7::uuid[]) t(id)',
        [...args, choices],
      );
      return;
    }
    let v = a.value;
    if (p.kind === 'text' && v === '') v = null;
    let columns: string[] = [];
    let values: unknown[] = [];
    if (v !== null) {
      if (p.kind === 'text' || p.kind === 'url') {
        if (
          typeof v !== 'string' ||
          [...v].length >
            (p.kind === 'url' ? this.limits.urlCharacters : this.limits.textCharacters)
        )
          fail();
        if (p.kind === 'url') {
          try {
            const url = new URL(v as string);
            if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) fail();
          } catch {
            fail();
          }
        }
        columns = ['text_value'];
        values = [v];
      } else if (p.kind === 'number') {
        if (typeof v !== 'string' || !/^[-+]?[0-9]{1,20}(\.[0-9]{1,8})?$/.test(v)) fail();
        columns = ['number_value'];
        values = [v];
      } else if (p.kind === 'checkbox') {
        if (typeof v !== 'boolean') fail();
        columns = ['boolean_value'];
        values = [v];
      } else if (p.kind === 'select') {
        const choices = ids([v], 1);
        await this.options(c, s, a, choices);
        columns = ['option_id'];
        values = [v];
      } else if (p.kind === 'date') {
        if (typeof v !== 'object' || !v || Array.isArray(v)) fail();
        const d = v as { start?: unknown; end?: unknown; timeZone?: unknown };
        if (
          Object.keys(d).some((k) => !['start', 'end', 'timeZone'].includes(k)) ||
          typeof d.start !== 'string' ||
          (d.end != null && typeof d.end !== 'string')
        )
          fail();
        const dates = [d.start, ...(d.end ? [d.end] : [])] as string[];
        if (p.config.mode === 'instant') {
          if (
            typeof d.timeZone !== 'string' ||
            dates.some(
              (x) =>
                !/^\d{4}-\d{2}-\d{2}T.+(?:Z|[+-]\d{2}:\d{2})$/.test(x) ||
                !civilDate(x.slice(0, 10)) ||
                !Number.isFinite(Date.parse(x)),
            )
          )
            fail();
          try {
            new Intl.DateTimeFormat('en', { timeZone: d.timeZone as string });
          } catch {
            fail();
          }
          if (d.end && Date.parse(d.end as string) < Date.parse(d.start as string)) fail();
          columns = ['date_time_start', 'date_time_end', 'time_zone'];
          values = [d.start, d.end ?? null, d.timeZone];
        } else {
          if (d.timeZone !== undefined || dates.some((x) => !civilDate(x))) fail();
          if (d.end && (d.end as string) < (d.start as string)) fail();
          columns = ['date_start', 'date_end'];
          values = [d.start, d.end ?? null];
        }
      } else fail();
    }
    await c.query(
      'DELETE FROM property_values WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3',
      [s.workspace, a.row, a.property],
    );
    if (v !== null)
      await c.query(
        `INSERT INTO property_values(workspace_id,database_id,row_page_id,property_id,kind,created_by,updated_by,${columns.join(',')}) VALUES($1,$2,$3,$4,$5,$6,$6,${values.map((_, i) => '$' + (i + 7)).join(',')})`,
        [...args, ...values],
      );
  }
  private async options(c: PoolClient, s: DatabaseSubject, a: CellAddress, choices: string[]) {
    if (
      (
        await c.query(
          `SELECT o.id FROM property_options o WHERE o.workspace_id=$1 AND o.database_id=$2 AND o.property_id=$3 AND o.id=ANY($4::uuid[]) AND (o.deleted_at IS NULL OR
          EXISTS(SELECT 1 FROM property_values v WHERE v.workspace_id=$1 AND v.row_page_id=$5 AND v.property_id=$3 AND v.option_id=o.id AND v.deleted_at IS NULL) OR
          EXISTS(SELECT 1 FROM multi_select_values v WHERE v.workspace_id=$1 AND v.row_page_id=$5 AND v.property_id=$3 AND v.option_id=o.id AND v.deleted_at IS NULL))`,
          [s.workspace, a.database, a.property, choices, a.row],
        )
      ).rowCount !== choices.length
    )
      fail('REFERENCE_UNAVAILABLE');
  }
  async changeSchema(
    s: DatabaseSubject,
    database: string,
    expected: string,
    property: string,
    change: { name?: string; archived?: boolean },
  ) {
    identifiers(s.workspace, database, property);
    version(expected);
    if (
      !Object.keys(change).length ||
      Object.keys(change).some((k) => !['name', 'archived'].includes(k)) ||
      (change.name !== undefined &&
        (typeof change.name !== 'string' ||
          !change.name.length ||
          [...change.name].length > this.limits.labelCharacters)) ||
      (change.archived !== undefined && typeof change.archived !== 'boolean')
    )
      fail();
    return this.transaction(async (c) => {
      const b = (
        await c.query<{ page_id: string; schema_version: string }>(
          'SELECT page_id,schema_version::text FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR UPDATE',
          [s.workspace, database],
        )
      ).rows[0];
      if (!b) fail('ACCESS_DENIED', 404);
      const roles = (
        await c.query<{ role: string }>('SELECT role FROM content_resolve_access($1::jsonb)', [
          accessRequests([{ ...s, key: 'base', page: b.page_id }]),
        ])
      ).rows[0];
      if (!roles || roles.role === 'guest') fail('ACCESS_DENIED', 404);
      if (b.schema_version !== expected)
        throw new DatabaseFault(409, 'SCHEMA_VERSION_CONFLICT', {
          schemaVersion: b.schema_version,
        });
      const changed = await c.query(
        'UPDATE database_properties SET name=coalesce($1,name),deleted_at=CASE WHEN $2::boolean IS NULL THEN deleted_at WHEN $2 THEN clock_timestamp() ELSE NULL END,updated_at=clock_timestamp() WHERE workspace_id=$3 AND database_id=$4 AND id=$5',
        [change.name ?? null, change.archived ?? null, s.workspace, database, property],
      );
      if (!changed.rowCount) fail('ACCESS_DENIED', 404);
      const v = (
        await c.query<{ version: string }>(
          'UPDATE databases SET schema_version=schema_version+1 WHERE workspace_id=$1 AND id=$2 RETURNING schema_version::text AS version',
          [s.workspace, database],
        )
      ).rows[0]!.version;
      const final = (
        await c.query<{ role: string }>('SELECT role FROM content_resolve_access($1::jsonb)', [
          accessRequests([{ ...s, key: 'base', page: b.page_id }]),
        ])
      ).rows[0];
      if (!final || final.role === 'guest') fail('ACCESS_DENIED', 404);
      return { schemaVersion: v };
    });
  }
  async setArchived(
    s: DatabaseSubject,
    database: string,
    row: string,
    expected: string,
    archived: boolean,
  ) {
    identifiers(s.workspace, database, row);
    version(expected);
    return this.transaction(async (c) => {
      await c.query(
        'SELECT id FROM databases WHERE workspace_id=$1 AND id=$2 ORDER BY id FOR SHARE',
        [s.workspace, database],
      );
      const r = (
        await c.query<{ page_id: string }>(
          'SELECT r.page_id FROM database_rows r WHERE r.workspace_id=$1 AND r.database_id=$2 AND r.page_id=$3 FOR UPDATE',
          [s.workspace, database, row],
        )
      ).rows[0];
      if (!r) fail('ACCESS_DENIED', 404);
      const b = (
        await c.query<{ page_id: string }>(
          'SELECT page_id FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
          [s.workspace, database],
        )
      ).rows[0];
      if (!b) fail('ACCESS_DENIED', 404);
      const roles = (
        await c.query<{ role: string; actor: string }>(
          'SELECT role,actor FROM content_resolve_access($1::jsonb)',
          [accessRequests([{ ...s, key: 'base', page: b.page_id }])],
        )
      ).rows[0];
      if (!roles || roles.role === 'guest') fail('ACCESS_DENIED', 404);
      const p = (
        await c.query<{ version: string }>(
          'SELECT version::text FROM pages WHERE workspace_id=$1 AND id=$2 FOR UPDATE',
          [s.workspace, row],
        )
      ).rows[0]!;
      if (p.version !== expected)
        throw new DatabaseFault(409, 'PAGE_VERSION_CONFLICT', { version: p.version });
      await c.query(
        'UPDATE pages SET deleted_at=CASE WHEN $1 THEN clock_timestamp() ELSE NULL END,version=version+1 WHERE workspace_id=$2 AND id=$3',
        [archived, s.workspace, row],
      );
      await c.query('SELECT database_mark_row($1,$2,$3,$4)', [
        s.workspace,
        database,
        row,
        roles.actor,
      ]);
      const final = (
        await c.query<{ role: string; actor: string }>(
          'SELECT role,actor FROM content_resolve_access($1::jsonb)',
          [accessRequests([{ ...s, key: 'base', page: b.page_id }])],
        )
      ).rows[0];
      if (!final || final.role === 'guest') fail('ACCESS_DENIED', 404);
      return { version: (BigInt(p.version) + 1n).toString() };
    });
  }
}
