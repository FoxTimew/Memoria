import { Injectable } from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { z } from 'zod';
import { drizzle } from 'drizzle-orm/node-postgres';
import {
  DatabaseCells,
  DatabaseFault,
  readDatabaseLimits,
  resolvePageAccess,
  accessRequests,
} from '@memoria/db';
import type { PoolClient, DatabaseSubject, PageAccess } from '@memoria/db';
import { requireSensitiveAction } from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import { canonicalJson, databaseQuerySchema } from '@memoria/contracts';
import * as db from '../../database.module.ts';
import * as blocks from '../blocks/block-write.service.ts';
import { compileTable, invalidQuery, signTableCursor, readTableCursor } from './table-compiler.ts';
import { readConfig } from '../../config.ts';
import type { TableProperty } from './table-compiler.ts';
import { DatabaseAdmission } from './database-quota.ts';
const id = z.uuid(),
  version = z
    .string()
    .regex(/^(0|[1-9][0-9]{0,18})$/)
    .refine((x) => BigInt(x) < 9223372036854775807n);
function fail(code = 'ACCESS_DENIED', status = 404): never {
  throw new DatabaseFault(status, code);
}
type Base = { id: string; page_id: string; schema_version: string };
@Injectable()
export class DatabaseObjectsService {
  readonly limits = readDatabaseLimits();
  readonly cells: DatabaseCells;
  private readonly secret = readConfig().BETTER_AUTH_SECRET;
  constructor(
    private readonly database: db.DatabaseService,
    private readonly writer: blocks.BlockWriteService,
    private readonly admission: DatabaseAdmission,
  ) {
    this.cells = new DatabaseCells(database.pool, this.limits);
  }
  parse<T>(schema: z.ZodType<T>, body: unknown): T {
    if (Buffer.byteLength(JSON.stringify(body) ?? '') > this.limits.mutationBytes)
      fail('DATABASE_MUTATION_TOO_LARGE', 413);
    const p = schema.safeParse(body);
    if (!p.success) fail('INVALID_DATABASE_INPUT', 400);
    return p.data;
  }
  subject(s: SessionIdentity, w: string): DatabaseSubject {
    if (!id.safeParse(w).success) fail('INVALID_DATABASE_INPUT', 400);
    return { workspace: w, user: s.userId, session: s.id };
  }
  async transaction<T>(work: (c: PoolClient) => Promise<T>) {
    return this.admission.run(async () => {
      const c = await this.database.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
          [String(this.limits.queryTimeoutMs)],
        );
        const out = await work(c);
        await c.query('COMMIT');
        return out;
      } catch (e) {
        await c.query('ROLLBACK');
        if (e instanceof DatabaseFault) throw e;
        const code = (e as { code?: string }).code;
        if (['23503', '23505', '23514', '22P02', '22003', '22007', '22008'].includes(code ?? ''))
          fail('INVALID_DATABASE_INPUT', 400);
        if (['40P01', '55P03', '57014'].includes(code ?? '')) fail('DATABASE_RETRY_REQUIRED', 503);
        throw e;
      } finally {
        c.release();
      }
    });
  }
  private async access(
    c: PoolClient,
    s: DatabaseSubject,
    page: string,
    mode: 'read' | 'edit' | 'schema' = 'read',
    base?: string,
  ): Promise<PageAccess & { role: string }> {
    const request = { ...s, key: page, page, ...(base ? { rowScope: { database: base } } : {}) };
    const result = (
      await c.query<{ actor: string; level: 'read' | 'edit'; role: string }>(
        `SELECT actor,level,role FROM ${base ? 'database' : 'content'}_resolve_access($1::jsonb)`,
        [accessRequests([request])],
      )
    ).rows[0];
    const a = result ? { ...request, ...result } : undefined;
    if (!a || (mode !== 'read' && a.level !== 'edit') || (mode === 'schema' && a.role === 'guest'))
      fail();
    return a;
  }
  private async base(c: PoolClient, s: DatabaseSubject, b: string, exclusive = false) {
    if (!id.safeParse(b).success) fail('INVALID_DATABASE_INPUT', 400);
    const row = (
      await c.query<Base>(
        `SELECT id,page_id,schema_version::text FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL FOR ${exclusive ? 'UPDATE' : 'SHARE'}`,
        [s.workspace, b],
      )
    ).rows[0];
    if (!row) fail();
    return row;
  }
  private async capacity(c: PoolClient, w: string, scope: string, resource: string, max: number) {
    const row = (
      await c.query<{ used: string }>(
        'SELECT used::text FROM database_counters WHERE workspace_id=$1 AND scope=$2 AND resource_id=$3',
        [w, scope, resource],
      )
    ).rows[0];
    if (!row || BigInt(row.used) > BigInt(max)) fail('DATABASE_CAPACITY_REACHED', 409);
  }
  private async audit(
    c: PoolClient,
    s: DatabaseSubject,
    actor: string,
    action: string,
    resource: string,
  ) {
    await c.query(
      "INSERT INTO audit_logs(workspace_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,$3,'database',$4,'{}')",
      [s.workspace, actor, action, resource],
    );
  }
  private schemaVersion(base: Base, expected: string) {
    if (base.schema_version !== expected)
      throw new DatabaseFault(409, 'SCHEMA_VERSION_CONFLICT', {
        schemaVersion: base.schema_version,
      });
  }
  private async bump(c: PoolClient, s: DatabaseSubject, b: string) {
    return (
      await c.query<{ schema_version: string }>(
        'UPDATE databases SET schema_version=schema_version+1,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2 RETURNING schema_version::text',
        [s.workspace, b],
      )
    ).rows[0]!.schema_version;
  }
  async list(session: SessionIdentity, w: string) {
    const s = this.subject(session, w);
    return this.transaction(async (c) => {
      const rows = (
        await c.query<Base>(
          'SELECT id,page_id,schema_version::text FROM databases WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY id FOR SHARE',
          [w],
        )
      ).rows;
      const rights = await resolvePageAccess(
        c,
        rows.map((b) => ({ ...s, key: b.id, page: b.page_id })),
      );
      const visible = rows.filter((b) => rights.has(b.id));
      const titles = (
        await c.query<{ id: string; title: string }>(
          'SELECT id,title FROM pages WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
          [w, visible.map((b) => b.page_id)],
        )
      ).rows;
      const finalRights = await resolvePageAccess(
        c,
        visible.map((b) => ({ ...s, key: b.id, page: b.page_id })),
      );
      return {
        databases: visible
          .filter((b) => finalRights.has(b.id))
          .map((b) => ({
            ...b,
            title: titles.find((p) => p.id === b.page_id)?.title ?? '',
            level: rights.get(b.id)!.level,
          })),
      };
    });
  }
  async get(session: SessionIdentity, w: string, b: string) {
    const s = this.subject(session, w);
    return this.transaction(async (c) => {
      await this.lockTargets(c, s, b);
      const base = await this.base(c, s, b),
        access = await this.access(c, s, base.page_id);
      const properties = (
        await c.query<TableProperty & { name: string; position: string }>(
          'SELECT id,name,kind,position,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND deleted_at IS NULL ORDER BY position,id',
          [w, b],
        )
      ).rows;
      // A hidden relation base is not disclosed in the schema either.
      const targets = (
        await c.query<Base>(
          'SELECT id,page_id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[])',
          [
            w,
            properties.flatMap((p) =>
              p.relation_target_database_id ? [p.relation_target_database_id] : [],
            ),
          ],
        )
      ).rows;
      const readable = await resolvePageAccess(
        c,
        targets.map((t) => ({ ...s, key: t.id, page: t.page_id })),
      );
      const view = (
        await c.query<{ config: unknown }>(
          'SELECT config FROM database_views WHERE workspace_id=$1 AND database_id=$2 AND deleted_at IS NULL LIMIT 1',
          [w, b],
        )
      ).rows[0]?.config ?? { filters: [], sorts: [] };
      // Saved reference filters are only returned after the same current visibility validation as queries.
      const parsed = databaseQuerySchema.safeParse(view);
      let visibleView = parsed.success ? parsed.data : { filters: [], sorts: [] };
      let unavailable = !parsed.success;
      try {
        compileTable(
          visibleView,
          properties,
          {
            workspace: w,
            database: b,
            user: s.user,
            guest: access.role === 'guest',
            readableTargets: targets.filter((t) => readable.has(t.id)).map((t) => t.id),
          },
          this.limits,
        );
        for (const f of visibleView.filters) {
          const p = properties.find((p) => p.id === f.field);
          if (
            p &&
            ['relation', 'person', 'select', 'multi_select'].includes(p.kind) &&
            Array.isArray(f.value)
          )
            await this.validateReferenceIds(c, s, b, p, f.value);
        }
      } catch (e) {
        if (!(e instanceof DatabaseFault)) throw e;
        unavailable = true;
      }
      if (unavailable) visibleView = { filters: [], sorts: [] };
      await this.access(c, s, base.page_id);
      const options = (
        await c.query(
          'SELECT id,property_id,label,color,deleted_at FROM property_options WHERE workspace_id=$1 AND database_id=$2 AND property_id=ANY($3::uuid[]) ORDER BY property_id,position,id',
          [w, b, properties.map((p) => p.id)],
        )
      ).rows;
      return {
        ...base,
        level: access.level,
        canManageSchema: access.role !== 'guest',
        properties: properties.map((p) => ({
          ...p,
          relation_target_database_id:
            p.relation_target_database_id && readable.has(p.relation_target_database_id)
              ? p.relation_target_database_id
              : null,
        })),
        options,
        view: visibleView,
        viewUnavailable: unavailable,
      };
    });
  }
  async create(session: SessionIdentity, w: string, input: unknown) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({ title: z.string().max(500), parentId: id.nullable().default(null) }),
        input,
      );
    return this.transaction(async (c) => {
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [w]);
      await c.query('SELECT database_lock_workspace($1)', [w]);
      const actor = (
        await c.query<{ actor: string }>(
          `SELECT a.id AS actor FROM workspace_members m JOIN actors a ON a.workspace_id=m.workspace_id AND a.user_id=m.user_id AND a.kind='user' WHERE m.workspace_id=$1 AND m.user_id=$2 AND m.role IN ('owner','admin','member') AND auth_session_can_access_workspace($3,$1) ORDER BY a.created_at,a.id LIMIT 1`,
          [w, s.user, s.session],
        )
      ).rows[0];
      if (!actor) fail();
      if (data.parentId) await this.access(c, s, data.parentId, 'schema');
      const count = Number(
        (
          await c.query<{ n: string }>(
            "SELECT count(*)::text AS n FROM pages WHERE workspace_id=$1 AND kind='page'",
            [w],
          )
        ).rows[0]!.n,
      );
      if (count >= 1000) fail('PAGE_CAPACITY_REACHED', 409);
      if (data.parentId) {
        const ancestors = (
          await c.query<{ n: string }>(
            `WITH RECURSIVE a AS (SELECT id,parent_id FROM pages WHERE workspace_id=$1 AND id=$2 UNION ALL SELECT p.id,p.parent_id FROM pages p JOIN a ON p.id=a.parent_id WHERE p.workspace_id=$1) SELECT count(*)::text n FROM a`,
            [w, data.parentId],
          )
        ).rows[0]!;
        if (Number(ancestors.n) >= 50) fail('PAGE_DEPTH_LIMIT', 400);
      }
      const page = randomUUID(),
        b = randomUUID();
      await c.query(
        'INSERT INTO pages(id,workspace_id,parent_id,title,position,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$6)',
        [page, w, data.parentId, data.title, 'a' + page.replaceAll('-', ''), actor.actor],
      );
      await c.query(
        'INSERT INTO databases(id,workspace_id,page_id,created_by,updated_by) VALUES($1,$2,$3,$4,$4)',
        [b, w, page, actor.actor],
      );
      await this.capacity(c, w, 'bases', w, this.limits.basesPerWorkspace);
      await c.query(
        "INSERT INTO database_views(workspace_id,database_id,name,position,config) VALUES($1,$2,'Tableau','a0',$3)",
        [w, b, { filters: [], sorts: [] }],
      );
      await this.access(c, s, page, 'schema');
      await this.audit(c, s, actor.actor, 'database.created', b);
      return { id: b, pageId: page, schemaVersion: '1' };
    });
  }
  async createRow(session: SessionIdentity, w: string, b: string, input: unknown) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({
          receipt: id,
          title: z.string().max(500).default(''),
          expectedSchemaVersion: version,
          values: z.array(z.strictObject({ property: id, value: z.unknown() })).default([]),
        }),
        input,
      );
    if (
      data.values.length > this.limits.propertiesPerBase ||
      new Set(data.values.map((v) => v.property)).size !== data.values.length
    )
      invalidQuery();
    return this.transaction(async (c) => {
      // Freeze the complete target-base plan before taking any base latch.
      const targets = (
        await c.query<{ id: string }>(
          'SELECT DISTINCT relation_target_database_id AS id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND relation_target_database_id IS NOT NULL AND deleted_at IS NULL',
          [w, b],
        )
      ).rows.map((r) => r.id);
      await c.query(
        'SELECT id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
        [w, [b, ...targets]],
      );
      const base = await this.base(c, s, b),
        access = await this.access(c, s, base.page_id, 'edit');
      this.schemaVersion(base, data.expectedSchemaVersion);
      const currentTargets = (
        await c.query<{ id: string }>(
          'SELECT DISTINCT relation_target_database_id AS id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND relation_target_database_id IS NOT NULL AND deleted_at IS NULL',
          [w, b],
        )
      ).rows.map((r) => r.id);
      if (currentTargets.some((t) => !targets.includes(t))) fail('DATABASE_RETRY_REQUIRED', 409);
      await c.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
        `row-create:${w}:${b}:${access.actor}:${data.receipt}`,
      ]);
      const hash = createHash('sha256').update(canonicalJson(data)).digest('hex');
      const previous = (
        await c.query<{ request_hash: string; row_page_id: string }>(
          'SELECT request_hash,row_page_id FROM database_create_receipts WHERE workspace_id=$1 AND database_id=$2 AND actor_id=$3 AND receipt=$4 AND expires_at>clock_timestamp()',
          [w, b, access.actor, data.receipt],
        )
      ).rows[0];
      if (previous) {
        if (previous.request_hash !== hash) fail('IDEMPOTENCY_CONFLICT', 409);
        await this.access(c, s, previous.row_page_id, 'edit', b);
        return { id: previous.row_page_id, replayed: true };
      }
      // Targets in initial relation sets are locked in the same global order as ordinary cell writes.
      const row = randomUUID(),
        targetRows = data.values.flatMap((v) => {
          const value = v.value as { add?: unknown } | null;
          return value && Array.isArray(value.add)
            ? value.add.filter((x): x is string => typeof x === 'string' && id.safeParse(x).success)
            : [];
        });
      await c.query(
        'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND page_id=ANY($2::uuid[]) ORDER BY page_id FOR SHARE',
        [w, targetRows],
      );
      await c.query(
        "INSERT INTO pages(id,workspace_id,kind,title,position,created_by,updated_by) VALUES($1,$2,'database_row',$3,'a0',$4,$4)",
        [row, w, data.title, access.actor],
      );
      await c.query(
        'INSERT INTO database_rows(workspace_id,database_id,page_id,created_by,updated_by) VALUES($1,$2,$3,$4,$4)',
        [w, b, row, access.actor],
      );
      await this.capacity(c, w, 'rows', w, this.limits.rowsPerWorkspace);
      await this.capacity(c, w, 'baseRows', b, this.limits.rowsPerBase);
      await this.writer.initializeRow(c, w, row);
      for (const value of [...data.values].sort((a, b) => a.property.localeCompare(b.property)))
        await this.cells.writeInTransaction(c, s, {
          database: b,
          row,
          property: value.property,
          value: value.value,
          expectedCellVersion: '0',
          expectedSchemaVersion: data.expectedSchemaVersion,
        });
      await c.query('SELECT database_refresh_row($1,$2)', [w, row]);
      await c.query(
        'INSERT INTO database_row_changes(workspace_id,database_id,row_page_id,event_revision) VALUES($1,$2,$3,1) ON CONFLICT(workspace_id,row_page_id) DO UPDATE SET event_revision=1,first_dirty_at=NULL,last_dirty_at=NULL',
        [w, b, row],
      );
      await c.query('DELETE FROM database_row_authors WHERE workspace_id=$1 AND row_page_id=$2', [
        w,
        row,
      ]);
      await c.query(
        "INSERT INTO outbox_events(workspace_id,type,actor_id,aggregate_id,aggregate_version,payload) VALUES($1::uuid,'database.row.created',$2,$3::uuid,1,jsonb_build_object('workspaceId',$1::text,'databaseId',$4::text,'rowId',$3::text,'eventRevision','1','propertyRevision',(SELECT property_revision::text FROM database_row_changes WHERE workspace_id=$1::uuid AND row_page_id=$3::uuid),'contentRevision',0))",
        [w, access.actor, row, b],
      );
      await c.query(
        'DELETE FROM database_create_receipts WHERE workspace_id=$1 AND database_id=$2 AND actor_id=$3 AND receipt=$4',
        [w, b, access.actor, data.receipt],
      );
      await c.query(
        "INSERT INTO database_create_receipts VALUES($1,$2,$3,$4,$5,$6,clock_timestamp()+interval '24 hours')",
        [w, b, access.actor, data.receipt, hash, row],
      );
      await this.audit(c, s, access.actor, 'database.row.created', row);
      await this.access(c, s, row, 'edit', b);
      return { id: row, replayed: false };
    });
  }
  async row(session: SessionIdentity, w: string, b: string, r: string) {
    const s = this.subject(session, w);
    return this.transaction(async (c) => {
      await this.base(c, s, b);
      await c.query(
        'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND database_id=$2 AND page_id=$3 FOR SHARE',
        [w, b, r],
      );
      await this.access(c, s, r, 'read', b);
      const row = (
        await c.query('SELECT id,title,version::text FROM pages WHERE workspace_id=$1 AND id=$2', [
          w,
          r,
        ])
      ).rows[0];
      await this.access(c, s, r, 'read', b);
      return row;
    });
  }
  async cell(
    session: SessionIdentity,
    w: string,
    b: string,
    r: string,
    p: string,
    input?: unknown,
  ) {
    const s = this.subject(session, w),
      a = { database: b, row: r, property: p };
    if (input === undefined) return this.admission.run(() => this.cells.read(s, a));
    const data = this.parse(
      z.strictObject({
        expectedCellVersion: version,
        expectedSchemaVersion: version,
        value: z.unknown(),
      }),
      input,
    );
    return this.admission.run(() => this.cells.write(s, { ...a, ...data }));
  }
  async renameRow(session: SessionIdentity, w: string, b: string, r: string, input: unknown) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({ expectedVersion: version, title: z.string().max(500) }),
        input,
      );
    return this.transaction(async (c) => {
      await this.base(c, s, b);
      await c.query(
        'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND database_id=$2 AND page_id=$3 FOR SHARE',
        [w, b, r],
      );
      const a = await this.access(c, s, r, 'edit', b);
      const row = (
        await c.query<{ version: string }>(
          'SELECT version::text FROM pages WHERE workspace_id=$1 AND id=$2 FOR NO KEY UPDATE',
          [w, r],
        )
      ).rows[0]!;
      if (row.version !== data.expectedVersion)
        throw new DatabaseFault(409, 'PAGE_VERSION_CONFLICT', { version: row.version });
      await c.query(
        'UPDATE pages SET title=$3,version=version+1,updated_by=$4,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
        [w, r, data.title, a.actor],
      );
      await c.query('SELECT database_mark_row($1,$2,$3,$4)', [w, b, r, a.actor]);
      await c.query('SELECT database_refresh_row($1,$2)', [w, r]);
      await this.access(c, s, r, 'edit', b);
      return { version: (BigInt(row.version) + 1n).toString() };
    });
  }
  async lifecycle(
    session: SessionIdentity,
    w: string,
    b: string,
    r: string,
    input: unknown,
    archived: boolean,
  ) {
    const data = this.parse(z.strictObject({ expectedVersion: version }), input);
    return this.admission.run(() =>
      this.cells.setArchived(this.subject(session, w), b, r, data.expectedVersion, archived),
    );
  }
  async property(
    session: SessionIdentity,
    w: string,
    b: string,
    p: string | undefined,
    input: unknown,
  ) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({
          expectedSchemaVersion: version,
          name: z.string().min(1).optional(),
          kind: z
            .enum([
              'text',
              'number',
              'select',
              'multi_select',
              'date',
              'checkbox',
              'person',
              'relation',
              'url',
            ])
            .optional(),
          config: z.strictObject({ mode: z.enum(['date', 'instant']).optional() }).optional(),
          targetDatabaseId: id.nullable().optional(),
          archived: z.boolean().optional(),
        }),
        input,
      );
    if (data.name && [...data.name].length > this.limits.labelCharacters) invalidQuery();
    return this.transaction(async (c) => {
      if (data.targetDatabaseId)
        await c.query(
          'SELECT id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR UPDATE',
          [w, [b, data.targetDatabaseId]],
        );
      const base = await this.base(c, s, b, true),
        a = await this.access(c, s, base.page_id, 'schema');
      this.schemaVersion(base, data.expectedSchemaVersion);
      const old = p
        ? (
            await c.query<TableProperty>(
              'SELECT id,kind,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND id=$3',
              [w, b, p],
            )
          ).rows[0]
        : undefined;
      if (p && !old) fail();
      const kind = data.kind ?? old?.kind;
      if (!kind || (!p && !data.name)) invalidQuery();
      const target =
        data.targetDatabaseId === undefined
          ? (old?.relation_target_database_id ?? null)
          : data.targetDatabaseId;
      if ((kind === 'relation') !== Boolean(target)) invalidQuery();
      if (target) {
        const t = (
          await c.query<Base>(
            'SELECT id,page_id FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
            [w, target],
          )
        ).rows[0];
        if (!t) fail('REFERENCE_UNAVAILABLE', 400);
        await this.access(c, s, t.page_id);
      }
      const config = data.config ?? old?.config ?? (kind === 'date' ? { mode: 'date' } : {});
      if (kind !== 'date' && Object.keys(config).length) invalidQuery();
      if (kind === 'date' && !['date', 'instant'].includes(String(config.mode))) invalidQuery();
      const property = p ?? randomUUID();
      if (p)
        await c.query(
          'UPDATE database_properties SET name=coalesce($4,name),kind=$5,config=$6,relation_target_database_id=$7,deleted_at=CASE WHEN $8::boolean IS NULL THEN deleted_at WHEN $8 THEN clock_timestamp() ELSE NULL END,updated_by=$9,updated_at=clock_timestamp() WHERE workspace_id=$1 AND database_id=$2 AND id=$3',
          [w, b, p, data.name ?? null, kind, config, target, data.archived ?? null, a.actor],
        );
      else {
        await c.query(
          'INSERT INTO database_properties(id,workspace_id,database_id,key,name,kind,position,config,relation_target_database_id,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$10)',
          [
            property,
            w,
            b,
            property,
            data.name,
            kind,
            'a' + property.replaceAll('-', ''),
            config,
            target,
            a.actor,
          ],
        );
        await this.capacity(c, w, 'properties', b, this.limits.propertiesPerBase);
      }
      if (data.archived || old?.kind === 'text' || kind === 'text')
        await c.query(
          'SELECT database_refresh_row($1,page_id) FROM database_rows WHERE workspace_id=$1 AND database_id=$2',
          [w, b],
        );
      const next = await this.bump(c, s, b);
      await this.audit(c, s, a.actor, 'database.property.changed', property);
      await this.access(c, s, base.page_id, 'schema');
      return { id: property, schemaVersion: next };
    });
  }
  async option(
    session: SessionIdentity,
    w: string,
    b: string,
    p: string,
    o: string | undefined,
    input: unknown,
  ) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({
          expectedSchemaVersion: version,
          label: z.string().min(1).optional(),
          color: z
            .string()
            .regex(/^[a-zA-Z0-9#-]{1,32}$/)
            .nullable()
            .optional(),
          archived: z.boolean().optional(),
        }),
        input,
      );
    if (data.label && [...data.label].length > this.limits.labelCharacters) invalidQuery();
    return this.transaction(async (c) => {
      const base = await this.base(c, s, b, true),
        a = await this.access(c, s, base.page_id, 'schema');
      this.schemaVersion(base, data.expectedSchemaVersion);
      const prop = (
        await c.query<{ kind: string }>(
          'SELECT kind FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND id=$3 AND deleted_at IS NULL',
          [w, b, p],
        )
      ).rows[0];
      if (!prop || !['select', 'multi_select'].includes(prop.kind)) fail();
      const option = o ?? randomUUID();
      if (o) {
        const changed = await c.query(
          'UPDATE property_options SET label=coalesce($4,label),color=CASE WHEN $5::boolean THEN $6 ELSE color END,deleted_at=CASE WHEN $7::boolean IS NULL THEN deleted_at WHEN $7 THEN clock_timestamp() ELSE NULL END,updated_by=$8,updated_at=clock_timestamp() WHERE workspace_id=$1 AND property_id=$2 AND id=$3',
          [
            w,
            p,
            o,
            data.label ?? null,
            data.color !== undefined,
            data.color ?? null,
            data.archived ?? null,
            a.actor,
          ],
        );
        if (!changed.rowCount) fail();
      } else {
        if (!data.label) invalidQuery();
        await c.query(
          'INSERT INTO property_options(id,workspace_id,database_id,property_id,kind,label,color,position,created_by,updated_by) VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9,$9)',
          [
            option,
            w,
            b,
            p,
            prop.kind,
            data.label,
            data.color ?? null,
            'a' + option.replaceAll('-', ''),
            a.actor,
          ],
        );
        await this.capacity(c, w, 'options', p, this.limits.optionsPerProperty);
      }
      const next = await this.bump(c, s, b);
      await this.audit(c, s, a.actor, 'database.option.changed', option);
      await this.access(c, s, base.page_id, 'schema');
      return { id: option, schemaVersion: next };
    });
  }
  async view(session: SessionIdentity, w: string, b: string, input: unknown) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({
          expectedSchemaVersion: version,
          view: databaseQuerySchema.omit({ cursor: true, pageSize: true }),
        }),
        input,
      );
    return this.transaction(async (c) => {
      await this.lockTargets(c, s, b, true);
      const base = await this.base(c, s, b, true),
        a = await this.access(c, s, base.page_id, 'schema');
      this.schemaVersion(base, data.expectedSchemaVersion);
      const properties = (
        await c.query<TableProperty>(
          'SELECT id,kind,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND deleted_at IS NULL',
          [w, b],
        )
      ).rows;
      compileTable(
        data.view,
        properties,
        { workspace: w, database: b, user: s.user, guest: false, readableTargets: [] },
        this.limits,
      );
      // Reference IDs must be visible now; saving a view cannot bypass selector validation.
      for (const f of data.view.filters) {
        const p = properties.find((p) => p.id === f.field);
        if (
          p &&
          ['person', 'relation', 'select', 'multi_select'].includes(p.kind) &&
          Array.isArray(f.value)
        )
          await this.validateReferenceIds(c, s, b, p, f.value);
      }
      const rows = (
        await c.query<{ id: string }>(
          'SELECT id FROM database_views WHERE workspace_id=$1 AND database_id=$2 AND deleted_at IS NULL',
          [w, b],
        )
      ).rows;
      if (rows.length)
        await c.query(
          'UPDATE database_views SET config=$3,updated_at=clock_timestamp() WHERE workspace_id=$1 AND id=$2',
          [w, rows[0]!.id, data.view],
        );
      else
        await c.query(
          "INSERT INTO database_views(workspace_id,database_id,name,position,config) VALUES($1,$2,'Tableau','a0',$3)",
          [w, b, data.view],
        );
      const next = await this.bump(c, s, b);
      await this.audit(c, s, a.actor, 'database.view.changed', b);
      await this.access(c, s, base.page_id, 'schema');
      return { schemaVersion: next };
    });
  }
  private async validateReferenceIds(
    c: PoolClient,
    s: DatabaseSubject,
    b: string,
    p: TableProperty,
    values: unknown[],
  ) {
    if (values.some((v) => !id.safeParse(v).success) || values.length > this.limits.filterValues)
      invalidQuery();
    const base = await this.base(c, s, b),
      a = await this.access(c, s, base.page_id);
    let rows: { id: string }[] = [];
    if (p.kind === 'person')
      rows = (
        await c.query<{ id: string }>(
          `SELECT dp.id FROM database_people dp JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id WHERE dp.workspace_id=$1 AND dp.id=ANY($2::uuid[]) AND ($3 OR m.user_id=$4 OR EXISTS(SELECT 1 FROM database_assignable_people ap WHERE ap.workspace_id=$1 AND ap.database_id=$5 AND ap.person_id=dp.id))`,
          [s.workspace, values, a.role !== 'guest', s.user, b],
        )
      ).rows;
    else if (p.kind === 'relation') {
      const target = (
        await c.query<Base>(
          'SELECT id,page_id FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
          [s.workspace, p.relation_target_database_id],
        )
      ).rows[0];
      if (
        target &&
        (await resolvePageAccess(c, [{ ...s, key: target.id, page: target.page_id }])).has(
          target.id,
        )
      )
        rows = (
          await c.query<{ id: string }>(
            'SELECT p.id FROM pages p JOIN database_rows r ON r.workspace_id=p.workspace_id AND r.page_id=p.id WHERE r.workspace_id=$1 AND r.database_id=$2 AND p.id=ANY($3::uuid[]) AND p.deleted_at IS NULL AND r.deleted_at IS NULL',
            [s.workspace, target.id, values],
          )
        ).rows;
    } else
      rows = (
        await c.query<{ id: string }>(
          'SELECT id FROM property_options WHERE workspace_id=$1 AND property_id=$2 AND id=ANY($3::uuid[])',
          [s.workspace, p.id, values],
        )
      ).rows;
    if (values.some((v) => !rows.some((r) => r.id === v))) invalidQuery();
  }
  async assignable(session: SessionIdentity, w: string, b: string, input?: unknown) {
    const s = this.subject(session, w);
    const data =
      input === undefined
        ? undefined
        : this.parse(
            z.strictObject({ expectedSchemaVersion: version, people: z.array(id) }),
            input,
          );
    if (
      data &&
      (data.people.length > this.limits.assignablePeople ||
        new Set(data.people).size !== data.people.length)
    )
      invalidQuery();
    return this.transaction(async (c) => {
      if (data)
        await requireSensitiveAction(
          drizzle(c) as unknown as import('@memoria/db').WriteTransaction,
          session,
          w,
          'workspace.access',
        );
      const base = await this.base(c, s, b, !!data),
        a = await this.access(c, s, base.page_id);
      if (data) {
        this.schemaVersion(base, data.expectedSchemaVersion);
        const people = (
          await c.query<{ id: string }>(
            'SELECT dp.id FROM database_people dp JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id WHERE dp.workspace_id=$1 AND dp.id=ANY($2::uuid[])',
            [w, data.people],
          )
        ).rows;
        if (people.length !== data.people.length) invalidQuery();
        await c.query(
          'DELETE FROM database_assignable_people WHERE workspace_id=$1 AND database_id=$2',
          [w, b],
        );
        await c.query(
          'INSERT INTO database_assignable_people(workspace_id,database_id,person_id) SELECT $1,$2,id FROM unnest($3::uuid[]) t(id)',
          [w, b, data.people],
        );
        const next = await this.bump(c, s, b);
        await this.audit(c, s, a.actor, 'database.assignable.changed', b);
        await this.access(c, s, base.page_id);
        return { schemaVersion: next };
      }
      const people = (
        await c.query<{ id: string; name: string }>(
          `SELECT dp.id,u.name FROM database_assignable_people ap JOIN database_people dp ON dp.workspace_id=ap.workspace_id AND dp.id=ap.person_id JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id JOIN auth_users u ON u.id=m.user_id WHERE ap.workspace_id=$1 AND ap.database_id=$2 ORDER BY dp.id`,
          [w, b],
        )
      ).rows;
      await this.access(c, s, base.page_id);
      return { people };
    });
  }
  private async lockTargets(c: PoolClient, s: DatabaseSubject, b: string, exclusive = false) {
    const targets = (
      await c.query<{ id: string }>(
        'SELECT DISTINCT relation_target_database_id id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND relation_target_database_id IS NOT NULL AND deleted_at IS NULL',
        [s.workspace, b],
      )
    ).rows.map((r) => r.id);
    await c.query(
      `SELECT id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR ${exclusive ? 'UPDATE' : 'SHARE'}`,
      [s.workspace, [b, ...targets]],
    );
    const current = (
      await c.query<{ id: string }>(
        'SELECT DISTINCT relation_target_database_id id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND relation_target_database_id IS NOT NULL AND deleted_at IS NULL',
        [s.workspace, b],
      )
    ).rows.map((r) => r.id);
    if (current.some((t) => !targets.includes(t))) fail('DATABASE_RETRY_REQUIRED', 409);
  }
  private async pagination(
    c: PoolClient,
    s: DatabaseSubject,
    b: Base,
    kind: string,
    input: unknown,
  ) {
    const data = this.parse(
      z.strictObject({
        q: z.string().max(200).default(''),
        pageSize: z.coerce.number().int().positive().optional(),
        cursor: z.string().max(16384).optional(),
      }),
      input,
    );
    const size = data.pageSize ?? this.limits.pageSize;
    if (size > this.limits.maxPageSize) invalidQuery();
    const epoch = (
      await c.query<{ version: number }>(
        'SELECT e.version FROM page_access_state e JOIN workspace_members m ON m.workspace_id=e.workspace_id AND m.id=e.member_id WHERE e.workspace_id=$1 AND e.page_id=$2 AND m.user_id=$3',
        [s.workspace, b.page_id, s.user],
      )
    ).rows[0]?.version;
    if (!epoch) fail();
    const scope = createHash('sha256')
      .update(canonicalJson([s, b.id, b.schema_version, epoch, kind, data.q, size]))
      .digest('hex');
    return {
      ...data,
      size,
      after:
        readTableCursor(this.secret, data.cursor, scope)?.id ??
        '00000000-0000-0000-0000-000000000000',
      finish: <T extends { id: string }>(rows: T[]) => ({
        items: rows.slice(0, size),
        hasMore: rows.length > size,
        cursor:
          rows.length > size ? signTableCursor(this.secret, scope, [], rows[size - 1]!.id) : null,
      }),
    };
  }
  async choices(session: SessionIdentity, w: string, b: string, p: string, input: unknown) {
    const s = this.subject(session, w);
    return this.transaction(async (c) => {
      await this.lockTargets(c, s, b);
      const base = await this.base(c, s, b),
        a = await this.access(c, s, base.page_id),
        query = await this.pagination(c, s, base, 'choices:' + p, input);
      const prop = (
        await c.query<TableProperty>(
          'SELECT id,kind,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND id=$3 AND deleted_at IS NULL',
          [w, b, p],
        )
      ).rows[0];
      if (!prop) fail();
      let rows: { id: string }[] = [];
      if (['select', 'multi_select'].includes(prop.kind))
        rows = (
          await c.query<{ id: string }>(
            'SELECT id,label,color FROM property_options WHERE workspace_id=$1 AND property_id=$2 AND deleted_at IS NULL AND id>$3 AND position(lower($4) in lower(label))>0 ORDER BY id LIMIT $5',
            [w, p, query.after, query.q, query.size + 1],
          )
        ).rows;
      else if (prop.kind === 'person')
        rows = (
          await c.query<{ id: string }>(
            `SELECT dp.id,u.name FROM database_people dp JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id JOIN auth_users u ON u.id=m.user_id WHERE dp.workspace_id=$1 AND dp.id>$2 AND position(lower($3) in lower(u.name))>0 AND ($4 OR m.user_id=$5 OR EXISTS(SELECT 1 FROM database_assignable_people ap WHERE ap.workspace_id=$1 AND ap.database_id=$6 AND ap.person_id=dp.id)) ORDER BY dp.id LIMIT $7`,
            [w, query.after, query.q, a.role !== 'guest', s.user, b, query.size + 1],
          )
        ).rows;
      else if (prop.kind === 'relation') {
        const target = (
          await c.query<Base>(
            'SELECT id,page_id FROM databases WHERE workspace_id=$1 AND id=$2 AND deleted_at IS NULL',
            [w, prop.relation_target_database_id],
          )
        ).rows[0];
        if (
          target &&
          (await resolvePageAccess(c, [{ ...s, key: target.id, page: target.page_id }])).has(
            target.id,
          )
        )
          rows = (
            await c.query<{ id: string }>(
              'SELECT p.id,p.title FROM pages p JOIN database_rows r ON r.workspace_id=p.workspace_id AND r.page_id=p.id WHERE r.workspace_id=$1 AND r.database_id=$2 AND p.deleted_at IS NULL AND r.deleted_at IS NULL AND p.id>$3 AND position(lower($4) in lower(p.title))>0 ORDER BY p.id LIMIT $5',
              [w, target.id, query.after, query.q, query.size + 1],
            )
          ).rows;
      } else invalidQuery();
      await this.access(c, s, base.page_id);
      return query.finish(rows);
    });
  }
  async trash(session: SessionIdentity, w: string, b: string, input: unknown) {
    const s = this.subject(session, w);
    return this.transaction(async (c) => {
      const base = await this.base(c, s, b);
      await this.access(c, s, base.page_id, 'schema');
      const q = await this.pagination(c, s, base, 'trash', input);
      const rows = (
        await c.query<{ id: string }>(
          'SELECT p.id,p.title,p.version::text,p.deleted_at FROM pages p JOIN database_rows r ON r.workspace_id=p.workspace_id AND r.page_id=p.id WHERE r.workspace_id=$1 AND r.database_id=$2 AND p.deleted_at IS NOT NULL AND p.id>$3 AND position(lower($4) in lower(p.title))>0 ORDER BY p.id LIMIT $5',
          [w, b, q.after, q.q, q.size + 1],
        )
      ).rows;
      await this.access(c, s, base.page_id, 'schema');
      return q.finish(rows);
    });
  }
  async rowAccess(session: SessionIdentity, w: string, input: unknown) {
    const s = this.subject(session, w),
      data = this.parse(
        z.strictObject({ rows: z.array(z.strictObject({ database: id, row: id })) }),
        input,
      );
    if (data.rows.length > this.limits.accessIds) invalidQuery();
    return this.transaction(async (c) => {
      const ids = [...new Set(data.rows.map((r) => r.database))].sort();
      const known = (
        await c.query<Base>(
          'SELECT id,page_id FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) ORDER BY id FOR SHARE',
          [w, ids],
        )
      ).rows;
      await c.query(
        'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND page_id=ANY($2::uuid[]) ORDER BY page_id FOR SHARE',
        [w, data.rows.map((r) => r.row)],
      );
      const states = (
        await c.query<{ id: string; version: number }>(
          'SELECT d.id,e.version FROM databases d JOIN workspace_members m ON m.workspace_id=d.workspace_id AND m.user_id=$3 JOIN page_access_state e ON e.workspace_id=d.workspace_id AND e.page_id=d.page_id AND e.member_id=m.id WHERE d.workspace_id=$1 AND d.id=ANY($2::uuid[])',
          [w, ids, s.user],
        )
      ).rows;
      const requests = known.map((b) => ({ ...s, key: b.id, page: b.page_id }));
      const rowRequests = data.rows.map((r) => ({
        ...s,
        key: r.database + ':' + r.row,
        page: r.row,
        rowScope: { database: r.database },
      }));
      const lifecycle = (
        await c.query<{ page_id: string; database_id: string; version: string }>(
          'SELECT page_id,database_id,lifecycle_version::text AS version FROM database_rows WHERE workspace_id=$1 AND page_id=ANY($2::uuid[])',
          [w, data.rows.map((r) => r.row)],
        )
      ).rows;
      // Recheck at the response boundary while all base/lifecycle barriers are held.
      const rights = await resolvePageAccess(c, [...requests, ...rowRequests]);
      return {
        bases: ids.map((database) => {
          const a = rights.get(database),
            state = states.find((x) => x.id === database);
          return a && state
            ? { database, available: true as const, version: state.version, level: a.level }
            : { database, available: false as const };
        }),
        rows: data.rows.map((r) => {
          const a = rights.get(r.database + ':' + r.row),
            state = states.find((x) => x.id === r.database),
            life = lifecycle.find((x) => x.page_id === r.row && x.database_id === r.database);
          return a && state && life
            ? {
                ...r,
                available: true as const,
                level: a.level,
                rowScope: {
                  database: r.database,
                  baseVersion: state.version,
                  lifecycle: life.version,
                },
              }
            : { ...r, available: false as const };
        }),
      };
    });
  }
  collaboration(session: SessionIdentity, w: string, b: string, r: string, input?: unknown) {
    return this.admission.run(() =>
      input === undefined
        ? this.writer.openRow(session, w, b, r)
        : this.writer.writeRow(session, w, b, r, input),
    );
  }
  async search(session: SessionIdentity, w: string, q: string) {
    const s = this.subject(session, w);
    if (typeof q !== 'string' || !q.trim() || q.length > 200) invalidQuery();
    return this.transaction(async (c) => {
      const bases = (
        await c.query<Base>(
          'SELECT id,page_id FROM databases WHERE workspace_id=$1 AND deleted_at IS NULL ORDER BY id FOR SHARE',
          [w],
        )
      ).rows;
      const rights = await resolvePageAccess(
        c,
        bases.map((b) => ({ ...s, key: b.id, page: b.page_id })),
      );
      const ids = bases.filter((b) => rights.has(b.id)).map((b) => b.id);
      if (!ids.length) return [];
      const rows = (
        await c.query(
          'SELECT p.id,p.title,r.database_id AS "databaseId",left(s.relational_text||chr(10)||s.body_text,240) AS excerpt FROM database_row_search s JOIN pages p ON p.workspace_id=s.workspace_id AND p.id=s.row_page_id JOIN database_rows r ON r.workspace_id=p.workspace_id AND r.page_id=p.id WHERE s.workspace_id=$1 AND r.database_id=ANY($2::uuid[]) AND p.deleted_at IS NULL AND r.deleted_at IS NULL AND s.vector@@plainto_tsquery(\'simple\',$3) ORDER BY p.updated_at DESC,p.id LIMIT 100',
          [w, ids, q],
        )
      ).rows;
      const final = await resolvePageAccess(
        c,
        bases.filter((b) => ids.includes(b.id)).map((b) => ({ ...s, key: b.id, page: b.page_id })),
      );
      return rows.filter((r) => final.has(r.databaseId));
    });
  }
}
