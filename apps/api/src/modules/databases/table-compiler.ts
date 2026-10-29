import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import type { DatabaseQuery } from '@memoria/contracts';
import { z } from 'zod';
import { DatabaseFault } from '@memoria/db';
import type { DatabaseLimits } from '@memoria/db';

export type TableProperty = {
  id: string;
  kind: string;
  config: Record<string, unknown>;
  relation_target_database_id: string | null;
};
export type TableContext = {
  workspace: string;
  database: string;
  user: string;
  guest: boolean;
  readableTargets: string[];
};
export function invalidQuery(): never {
  throw new DatabaseFault(400, 'INVALID_DATABASE_QUERY');
}
const uuid = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
export function queryFingerprint(query: DatabaseQuery) {
  const { cursor: _, ...rest } = query;
  void _;
  return createHash('sha256').update(JSON.stringify(rest)).digest('hex');
}
type Cursor = { scope: string; expires: number; keys: (string | null)[]; id: string };
export function signTableCursor(
  secret: string,
  scope: string,
  keys: (string | null)[],
  id: string,
) {
  const data = Buffer.from(
    JSON.stringify({ scope, expires: Date.now() + 15 * 60_000, keys, id }),
  ).toString('base64url');
  return (
    data +
    '.' +
    createHmac('sha256', secret)
      .update('database-table-v1:' + data)
      .digest('base64url')
  );
}
export function readTableCursor(
  secret: string,
  token: string | undefined,
  scope: string,
): Cursor | undefined {
  if (!token) return undefined;
  try {
    if (token.length > 16384) throw new Error();
    const [data, signature, ...extra] = token.split('.');
    if (!data || !signature || extra.length) throw new Error();
    const expected = createHmac('sha256', secret)
      .update('database-table-v1:' + data)
      .digest();
    const actual = Buffer.from(signature, 'base64url');
    if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) throw new Error();
    const c = JSON.parse(Buffer.from(data, 'base64url').toString()) as Cursor;
    if (
      c.scope !== scope ||
      !Number.isSafeInteger(c.expires) ||
      c.expires < Date.now() ||
      !uuid.test(c.id) ||
      !Array.isArray(c.keys) ||
      c.keys.length > 2 ||
      c.keys.some((v) => v !== null && typeof v !== 'string')
    )
      throw new Error();
    return c;
  } catch {
    throw new DatabaseFault(409, 'TABLE_CURSOR_STALE');
  }
}

export function compileTable(
  query: DatabaseQuery,
  properties: TableProperty[],
  ctx: TableContext,
  limits: DatabaseLimits,
  cursor?: Cursor,
) {
  if (
    query.filters.length > limits.filters ||
    query.sorts.length > limits.sorts ||
    (query.pageSize ?? limits.pageSize) > limits.maxPageSize
  )
    invalidQuery();
  const values: unknown[] = [],
    joins: string[] = [],
    aliases = new Map<string, string>();
  const param = (v: unknown) => {
    values.push(v);
    return '$' + values.length;
  };
  const w = param(ctx.workspace),
    base = param(ctx.database);
  const property = (id: string) => {
    const p = properties.find((p) => p.id === id);
    if (!p) invalidQuery();
    return p;
  };
  const scalar = (p: TableProperty) => {
    let alias = aliases.get(p.id);
    if (!alias) {
      alias = 'v' + aliases.size;
      aliases.set(p.id, alias);
      joins.push(
        `LEFT JOIN property_values ${alias} ON ${alias}.workspace_id=r.workspace_id AND ${alias}.row_page_id=r.page_id AND ${alias}.property_id=${param(p.id)} AND ${alias}.deleted_at IS NULL`,
      );
    }
    const columns: Record<string, string> = {
      text: 'text_value',
      url: 'text_value',
      number: 'number_value',
      checkbox: 'boolean_value',
      date: p.config.mode === 'instant' ? 'date_time_start' : 'date_start',
      select: 'option_id',
    };
    const column = columns[p.kind];
    if (!column) invalidQuery();
    return `${alias}.${column}`;
  };
  const text = (v: unknown, max = limits.textCharacters) => {
    if (typeof v !== 'string' || [...v].length > max) invalidQuery();
    return v;
  };
  const decimal = (v: unknown) => {
    const s = text(v, 40);
    if (!/^-?\d{1,20}(\.\d{1,8})?$/.test(s)) invalidQuery();
    return s;
  };
  const date = (v: unknown, instant: boolean) => {
    const s = text(v, 64);
    if (
      instant
        ? !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,6})?(Z|[+-]\d{2}:\d{2})$/.test(s)
        : !/^\d{4}-\d{2}-\d{2}$/.test(s)
    )
      invalidQuery();
    if (!(instant ? z.iso.datetime({ offset: true }) : z.iso.date()).safeParse(s).success)
      invalidQuery();
    return s;
  };
  const list = (v: unknown) => {
    if (
      !Array.isArray(v) ||
      !v.length ||
      v.length > limits.filterValues ||
      v.some((x) => typeof x !== 'string' || !uuid.test(x)) ||
      new Set(v).size !== v.length
    )
      invalidQuery();
    return v as string[];
  };
  const where = [
    `r.workspace_id=${w} AND r.database_id=${base} AND r.deleted_at IS NULL AND p.deleted_at IS NULL`,
  ];
  for (const filter of query.filters) {
    const prop = filter.field === 'title' ? undefined : property(filter.field);
    const kind = prop?.kind ?? 'text',
      op = filter.op,
      value = filter.value;
    const empty = op === 'empty' || op === 'notEmpty';
    if (empty && value !== undefined) invalidQuery();
    if (kind === 'files') {
      if (!empty) invalidQuery();
      where.push(
        `${op === 'empty' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM file_usages u JOIN files f ON f.workspace_id=u.workspace_id AND f.id=u.file_id WHERE u.workspace_id=${w} AND u.page_id=p.id AND u.slot_kind='cell' AND u.slot_id=${param(prop!.id)} AND f.state='ready' AND f.deleted_at IS NULL)`,
      );
      continue;
    }
    if (['multi_select', 'person', 'relation'].includes(kind)) {
      if (!empty && op !== 'any') invalidQuery();
      const table =
        kind === 'relation'
          ? 'relation_values'
          : kind === 'person'
            ? 'person_values'
            : 'multi_select_values';
      const column =
        kind === 'relation' ? 'target_page_id' : kind === 'person' ? 'member_id' : 'option_id';
      let extra = '',
        join = '';
      if (kind === 'person') {
        join =
          ' JOIN database_people dp ON dp.workspace_id=v.workspace_id AND dp.id=v.member_id JOIN workspace_members m ON m.workspace_id=dp.workspace_id AND m.id=dp.member_id';
        extra = ` AND (${ctx.guest ? `m.user_id=${param(ctx.user)} OR EXISTS(SELECT 1 FROM database_assignable_people ap WHERE ap.workspace_id=v.workspace_id AND ap.database_id=v.database_id AND ap.person_id=dp.id)` : 'true'})`;
      }
      if (kind === 'relation') {
        join =
          ' JOIN pages target ON target.workspace_id=v.workspace_id AND target.id=v.target_page_id JOIN database_rows tr ON tr.workspace_id=v.workspace_id AND tr.page_id=target.id';
        extra = ` AND target.deleted_at IS NULL AND tr.deleted_at IS NULL AND ${param(ctx.readableTargets.includes(prop!.relation_target_database_id!))}`;
      }
      const ids = empty ? '' : ` AND v.${column}=ANY(${param(list(value))}::uuid[])`;
      where.push(
        `${op === 'empty' ? 'NOT ' : ''}EXISTS(SELECT 1 FROM ${table} v${join} WHERE v.workspace_id=${w} AND v.row_page_id=p.id AND v.property_id=${param(prop!.id)} AND v.deleted_at IS NULL${extra}${ids})`,
      );
      continue;
    }
    const expression = prop ? scalar(prop) : 'p.title';
    if (empty) {
      where.push(
        `${prop ? expression : "NULLIF(p.title,'')"} IS ${op === 'empty' ? '' : 'NOT '}NULL`,
      );
      continue;
    }
    if (kind === 'text' || kind === 'url') {
      if (!['eq', 'contains', 'startsWith'].includes(op)) invalidQuery();
      const v = param(text(value, kind === 'url' ? limits.urlCharacters : limits.textCharacters));
      where.push(
        op === 'contains'
          ? `position(lower(${v}) in lower(${expression}))>0`
          : op === 'startsWith'
            ? `starts_with(lower(${expression}),lower(${v}))`
            : `lower(${expression})=lower(${v})`,
      );
    } else if (kind === 'number' || kind === 'date') {
      const cast =
        kind === 'number' ? 'numeric' : prop?.config.mode === 'instant' ? 'timestamptz' : 'date';
      const parse = (v: unknown) =>
        kind === 'number' ? decimal(v) : date(v, cast === 'timestamptz');
      if (op === 'between') {
        if (!Array.isArray(value) || value.length !== 2) invalidQuery();
        where.push(
          `${expression} BETWEEN ${param(parse(value[0]))}::${cast} AND ${param(parse(value[1]))}::${cast}`,
        );
      } else {
        const operators: Record<string, string> = {
          eq: '=',
          ne: '<>',
          lt: '<',
          lte: '<=',
          gt: '>',
          gte: '>=',
        };
        const comparison = operators[op];
        if (!comparison || (kind === 'date' && !['eq', 'lt', 'gt'].includes(op))) invalidQuery();
        where.push(`${expression}${comparison}${param(parse(value))}::${cast}`);
      }
    } else if (kind === 'checkbox') {
      if (op !== 'eq' || typeof value !== 'boolean') invalidQuery();
      where.push(`${expression}=${param(value)}`);
    } else if (kind === 'select') {
      if (op !== 'in') invalidQuery();
      where.push(`${expression}=ANY(${param(list(value))}::uuid[])`);
    } else invalidQuery();
  }
  if (new Set(query.sorts.map((s) => s.field)).size !== query.sorts.length) invalidQuery();
  const keys = query.sorts.map((s, i) => {
    const p = s.field === 'title' ? undefined : property(s.field);
    let expression = p ? scalar(p) : 'p.title',
      cast = 'text';
    if (!p || p.kind === 'text' || p.kind === 'url')
      expression = `lower(${expression}) COLLATE "C"`;
    else if (p.kind === 'select') {
      joins.push(
        `LEFT JOIN property_options o${i} ON o${i}.workspace_id=r.workspace_id AND o${i}.property_id=${param(p.id)} AND o${i}.id=${expression}`,
      );
      expression = `lower(o${i}.label) COLLATE "C"`;
    } else
      cast =
        p.kind === 'number'
          ? 'numeric'
          : p.kind === 'checkbox'
            ? 'boolean'
            : p.config.mode === 'instant'
              ? 'timestamptz'
              : 'date';
    return { expression, cast, direction: s.direction === 'asc' ? 'ASC' : 'DESC' };
  });
  if (cursor) {
    if (cursor.keys.length !== keys.length) throw new DatabaseFault(409, 'TABLE_CURSOR_STALE');
    const equals: string[] = [],
      alternatives: string[] = [];
    keys.forEach((key, i) => {
      const v = param(cursor.keys[i]);
      const typed = `${v}::${key.cast}${key.cast === 'text' ? ' COLLATE "C"' : ''}`;
      if (cursor.keys[i] !== null)
        alternatives.push(
          [
            ...equals,
            `(${key.expression} IS NULL OR ${key.expression}${key.direction === 'ASC' ? '>' : '<'}${typed})`,
          ].join(' AND '),
        );
      equals.push(`${key.expression} IS NOT DISTINCT FROM ${typed}`);
    });
    alternatives.push([...equals, `p.id>${param(cursor.id)}::uuid`].join(' AND '));
    where.push('(' + alternatives.map((a) => '(' + a + ')').join(' OR ') + ')');
  }
  const order = [...keys.map((k) => `${k.expression} ${k.direction} NULLS LAST`), 'p.id ASC'];
  const textSql = `SELECT p.id,p.title,p.version,p.updated_at${keys.map((k, i) => `,(${k.expression})::text AS "k${i}"`).join('')} FROM database_rows r JOIN pages p ON p.workspace_id=r.workspace_id AND p.id=r.page_id ${joins.join(' ')} WHERE ${where.join(' AND ')} ORDER BY ${order.join(',')} LIMIT ${param((query.pageSize ?? limits.pageSize) + 1)}`;
  return { text: textSql, values, keyCount: keys.length };
}
