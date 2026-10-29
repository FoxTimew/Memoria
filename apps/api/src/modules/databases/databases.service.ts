import { Injectable } from '@nestjs/common';
import { createHash } from 'node:crypto';
import type { PoolClient } from '@memoria/db';
import { databaseQuerySchema } from '@memoria/contracts';
import { accessRequests, DatabaseFault, readDatabaseLimits } from '@memoria/db';
import type { SessionIdentity } from '@memoria/auth';
import * as database from '../../database.module.ts';
import { readConfig } from '../../config.ts';
import { DatabaseAdmission } from './database-quota.ts';
import {
  compileTable,
  invalidQuery,
  queryFingerprint,
  readTableCursor,
  signTableCursor,
} from './table-compiler.ts';
import type { TableProperty } from './table-compiler.ts';
type Selected = {
  id: string;
  title: string;
  version: number;
  updated_at: Date;
  k0?: string | null;
  k1?: string | null;
};
@Injectable()
export class DatabasesService {
  readonly limits = readDatabaseLimits();
  private readonly secret = readConfig().BETTER_AUTH_SECRET;
  /** Internal observer for EXPLAIN on the same fixture, never enabled by HTTP input. */
  queryObserver?: (c: PoolClient, query: { text: string; values: unknown[] }) => Promise<void>;
  constructor(
    private readonly database: database.DatabaseService,
    private readonly admission: DatabaseAdmission,
  ) {}
  async query(session: SessionIdentity, workspace: string, id: string, input: unknown) {
    if (!/^[0-9a-f-]{36}$/i.test(workspace) || !/^[0-9a-f-]{36}$/i.test(id)) invalidQuery();
    if (Buffer.byteLength(JSON.stringify(input) ?? '') > this.limits.queryBytes)
      throw new DatabaseFault(413, 'DATABASE_QUERY_TOO_LARGE');
    const parsed = databaseQuerySchema.safeParse(input);
    if (!parsed.success) invalidQuery();
    const q = parsed.data;
    if (
      q.filters.length > this.limits.filters ||
      q.sorts.length > this.limits.sorts ||
      (q.pageSize ?? this.limits.pageSize) > this.limits.maxPageSize
    )
      invalidQuery();
    return this.admission.run(async () => {
      const c = await this.database.pool.connect();
      try {
        await c.query('BEGIN');
        await c.query(
          "SELECT set_config('statement_timeout',$1,true),set_config('lock_timeout',$1,true)",
          [String(this.limits.queryTimeoutMs)],
        );
        const definitions = () =>
          c.query<TableProperty>(
            'SELECT id,kind,config,relation_target_database_id FROM database_properties WHERE workspace_id=$1 AND database_id=$2 AND deleted_at IS NULL ORDER BY id',
            [workspace, id],
          );
        const preliminary = (await definitions()).rows;
        const targets = [
          ...new Set(
            preliminary.flatMap((p) =>
              p.relation_target_database_id ? [p.relation_target_database_id] : [],
            ),
          ),
        ];
        const bases = (
          await c.query<{ id: string; page_id: string; schema_version: string }>(
            'SELECT id,page_id,schema_version::text FROM databases WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND deleted_at IS NULL ORDER BY id FOR SHARE',
            [workspace, [id, ...targets]],
          )
        ).rows;
        const base = bases.find((b) => b.id === id);
        if (!base) throw new DatabaseFault(404, 'ACCESS_DENIED');
        const requests = accessRequests(
          bases.map((b) => ({
            key: b.id,
            user: session.userId,
            session: session.id,
            workspace,
            page: b.page_id,
          })),
        );
        const access = async () =>
          (
            await c.query<{ key: string; role: string; level: string }>(
              'SELECT key,role,level FROM content_resolve_access($1::jsonb)',
              [requests],
            )
          ).rows;
        const allowed = await access(),
          self = allowed.find((a) => a.key === id);
        if (!self) throw new DatabaseFault(404, 'ACCESS_DENIED');
        const properties = (await definitions()).rows;
        if (
          properties.some(
            (p) =>
              p.relation_target_database_id && !targets.includes(p.relation_target_database_id),
          )
        )
          throw new DatabaseFault(409, 'RETRY_REQUIRED');
        const readableTargets = targets.filter((t) => allowed.some((a) => a.key === t)),
          guest = self.role === 'guest';
        // Invalid/invisible filter references have one response, with no count/title/identifier.
        for (const filter of q.filters) {
          const prop = properties.find((p) => p.id === filter.field);
          if (!prop || !['any', 'in'].includes(filter.op) || !Array.isArray(filter.value)) continue;
          const values = filter.value;
          if (
            values.length > this.limits.filterValues ||
            values.some((v) => typeof v !== 'string' || !/^[a-f0-9-]{36}$/i.test(v))
          )
            invalidQuery();
          let visible: string[] = [];
          if (prop.kind === 'relation') {
            if (readableTargets.includes(prop.relation_target_database_id!))
              visible = (
                await c.query<{ id: string }>(
                  'SELECT p.id FROM pages p JOIN database_rows r ON r.workspace_id=p.workspace_id AND r.page_id=p.id WHERE r.workspace_id=$1 AND r.database_id=$2 AND p.id=ANY($3::uuid[]) AND p.deleted_at IS NULL AND r.deleted_at IS NULL',
                  [workspace, prop.relation_target_database_id, values],
                )
              ).rows.map((r) => r.id);
          } else if (prop.kind === 'person') {
            visible = (
              await c.query<{ id: string }>(
                `SELECT dp.id FROM database_people dp JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id WHERE dp.workspace_id=$1 AND dp.id=ANY($2::uuid[]) AND ($3 OR m.user_id=$4 OR EXISTS(SELECT 1 FROM database_assignable_people a WHERE a.workspace_id=dp.workspace_id AND a.database_id=$5 AND a.person_id=dp.id))`,
                [workspace, values, !guest, session.userId, id],
              )
            ).rows.map((r) => r.id);
          } else if (prop.kind === 'select' || prop.kind === 'multi_select') {
            visible = (
              await c.query<{ id: string }>(
                'SELECT id FROM property_options WHERE workspace_id=$1 AND property_id=$2 AND id=ANY($3::uuid[])',
                [workspace, prop.id, values],
              )
            ).rows.map((r) => r.id);
          } else invalidQuery();
          if (values.some((v) => !visible.includes(v as string))) invalidQuery();
        }
        const epoch = (
          await c.query<{ version: number }>(
            'SELECT s.version FROM page_access_state s JOIN workspace_members m ON m.workspace_id=s.workspace_id AND m.id=s.member_id WHERE s.workspace_id=$1 AND s.page_id=$2 AND m.user_id=$3',
            [workspace, base.page_id, session.userId],
          )
        ).rows[0]?.version;
        if (epoch === undefined) throw new DatabaseFault(404, 'ACCESS_DENIED');
        const scope = createHash('sha256')
          .update(
            JSON.stringify([
              workspace,
              id,
              session.userId,
              session.id,
              base.schema_version,
              epoch,
              queryFingerprint(q),
            ]),
          )
          .digest('hex');
        const cursor = readTableCursor(this.secret, q.cursor, scope);
        const compiled = compileTable(
          q,
          properties,
          { workspace, database: id, user: session.userId, guest, readableTargets },
          this.limits,
          cursor,
        );
        if (this.queryObserver) await this.queryObserver(c, compiled);
        const selected = (await c.query<Selected>(compiled.text, compiled.values)).rows;
        let page = selected.slice(0, q.pageSize ?? this.limits.pageSize);
        const ids = page.map((r) => r.id),
          propertyIds = properties.map((p) => p.id);
        const scalar = (
          await c.query(
            'SELECT row_page_id,property_id,kind,text_value,number_value::text,boolean_value,option_id,date_start::text,date_end::text,date_time_start::text,date_time_end::text,time_zone FROM property_values WHERE workspace_id=$1 AND row_page_id=ANY($2::uuid[]) AND property_id=ANY($3::uuid[]) AND deleted_at IS NULL',
            [workspace, ids, propertyIds],
          )
        ).rows;
        const multi = (
          await c.query(
            'SELECT row_page_id,property_id,jsonb_agg(option_id ORDER BY option_id) AS items FROM multi_select_values WHERE workspace_id=$1 AND row_page_id=ANY($2::uuid[]) AND property_id=ANY($3::uuid[]) AND deleted_at IS NULL GROUP BY row_page_id,property_id',
            [workspace, ids, propertyIds],
          )
        ).rows;
        const person = (
          await c.query(
            `SELECT v.row_page_id,v.property_id,bool_or(m.id IS NULL OR NOT ($3 OR m.user_id=$4 OR a.person_id IS NOT NULL)) AS "hasHidden",coalesce(jsonb_agg(jsonb_build_object('id',dp.id,'name',u.name)) FILTER(WHERE m.id IS NOT NULL AND ($3 OR m.user_id=$4 OR a.person_id IS NOT NULL)),'[]') AS items FROM person_values v LEFT JOIN database_people dp ON dp.workspace_id=v.workspace_id AND dp.id=v.member_id LEFT JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id LEFT JOIN auth_users u ON u.id=m.user_id LEFT JOIN database_assignable_people a ON a.workspace_id=v.workspace_id AND a.database_id=v.database_id AND a.person_id=dp.id WHERE v.workspace_id=$1 AND v.row_page_id=ANY($2::uuid[]) AND v.property_id=ANY($5::uuid[]) AND v.deleted_at IS NULL GROUP BY v.row_page_id,v.property_id`,
            [workspace, ids, !guest, session.userId, propertyIds],
          )
        ).rows;
        const relation = (
          await c.query(
            `SELECT v.row_page_id,v.property_id,bool_or(NOT (v.target_database_id=ANY($3::uuid[])) OR p.deleted_at IS NOT NULL OR r.deleted_at IS NOT NULL) AS "hasHidden",coalesce(jsonb_agg(jsonb_build_object('id',p.id,'title',p.title)) FILTER(WHERE v.target_database_id=ANY($3::uuid[]) AND p.deleted_at IS NULL AND r.deleted_at IS NULL),'[]') AS items FROM relation_values v JOIN pages p ON p.workspace_id=v.workspace_id AND p.id=v.target_page_id JOIN database_rows r ON r.workspace_id=v.workspace_id AND r.page_id=p.id WHERE v.workspace_id=$1 AND v.row_page_id=ANY($2::uuid[]) AND v.property_id=ANY($4::uuid[]) AND v.deleted_at IS NULL GROUP BY v.row_page_id,v.property_id`,
            [workspace, ids, readableTargets, propertyIds],
          )
        ).rows;
        const files = properties.some((p) => p.kind === 'files')
          ? (
              await c.query(
                `SELECT u.page_id AS row_page_id,u.slot_id AS property_id,
           bool_or(f.state<>'ready' OR f.deleted_at IS NOT NULL) AS "hasHidden",
           coalesce(jsonb_agg(jsonb_build_object('id',f.id,'name',f.original_name) ORDER BY f.id) FILTER(WHERE f.state='ready' AND f.deleted_at IS NULL),'[]') AS items
           FROM file_usages u JOIN files f ON f.workspace_id=u.workspace_id AND f.id=u.file_id
           WHERE u.workspace_id=$1 AND u.page_id=ANY($2::uuid[]) AND u.slot_kind='cell' AND u.slot_id=ANY($3::uuid[]) GROUP BY u.page_id,u.slot_id`,
                [workspace, ids, properties.filter((p) => p.kind === 'files').map((p) => p.id)],
              )
            ).rows
          : [];
        const versions = (
          await c.query(
            'SELECT row_page_id,property_id,version::text FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=ANY($2::uuid[]) AND property_id=ANY($3::uuid[])',
            [workspace, ids, propertyIds],
          )
        ).rows;
        const output = () => {
          const last = page.at(-1),
            kept = new Set(page.map((r) => r.id));
          const hasMore = selected.length > page.length;
          return {
            rows: page.map((r) => ({
              id: r.id,
              title: r.title,
              version: r.version,
              updatedAt: r.updated_at.toISOString(),
            })),
            schemaVersion: base.schema_version,
            scalar: scalar.filter((v) => kept.has(v.row_page_id)),
            multi: multi.filter((v) => kept.has(v.row_page_id)),
            person: person.filter((v) => kept.has(v.row_page_id)),
            relation: relation.filter((v) => kept.has(v.row_page_id)),
            files: files.filter((v) => kept.has(v.row_page_id)),
            versions: versions.filter((v) => kept.has(v.row_page_id)),
            hasMore,
            cursor:
              hasMore && last
                ? signTableCursor(
                    this.secret,
                    scope,
                    Array.from(
                      { length: compiled.keyCount },
                      (_, i) => last[i === 0 ? 'k0' : 'k1'] ?? null,
                    ),
                    last.id,
                  )
                : null,
          };
        };
        let result = output();
        while (
          page.length &&
          Buffer.byteLength(JSON.stringify(result)) > this.limits.responseBytes
        ) {
          page = page.slice(0, -1);
          result = output();
        }
        if (selected.length && !page.length)
          throw new DatabaseFault(413, 'DATABASE_RESPONSE_TOO_LARGE');
        const finalAccess = await access();
        if (
          !finalAccess.some((a) => a.key === id) ||
          readableTargets.some((t) => !finalAccess.some((a) => a.key === t))
        )
          throw new DatabaseFault(404, 'ACCESS_DENIED');
        await c.query('COMMIT');
        return result;
      } catch (error) {
        await c.query('ROLLBACK');
        if (error instanceof DatabaseFault) throw error;
        const code = (error as { code?: string }).code;
        if (code && ['57014', '55P03', '40P01'].includes(code))
          throw new DatabaseFault(503, 'DATABASE_RETRY_REQUIRED');
        if (code && ['22P02', '22003', '22007', '22008'].includes(code)) invalidQuery();
        throw error;
      } finally {
        c.release();
      }
    });
  }
}
