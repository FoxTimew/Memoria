import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { auditReferences, businessFields, rank, searchVector, time } from './common.ts';
import type { JsonObject } from './common.ts';

export const pages = pgTable(
  'pages',
  {
    ...businessFields(),
    parentId: uuid('parent_id'),
    title: text('title').default('').notNull(),
    icon: text('icon'),
    position: rank('position').notNull(),
    version: bigint('version', { mode: 'number' }).default(1).notNull(),
  },
  (t) => [
    unique('pages_workspace_id_uq').on(t.workspaceId, t.id),
    foreignKey({ columns: [t.workspaceId, t.parentId], foreignColumns: [t.workspaceId, t.id] }),
    ...auditReferences(t),
    uniqueIndex('pages_sibling_position_uq')
      .on(
        t.workspaceId,
        sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.position,
      )
      .where(sql`${t.deletedAt} is null`),
    index('pages_parent_idx').on(t.workspaceId, t.parentId),
    index('pages_trash_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    check('pages_not_self_ck', sql`${t.parentId} is distinct from ${t.id}`),
    check('pages_rank_ck', sql`${t.position} ~ '^[0-9A-Za-z]+$'`),
    check('pages_version_ck', sql`${t.version} between 1 and 9007199254740991`),
    check('pages_non_nil_ck', sql`${t.id} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  ],
);

export const blocks = pgTable(
  'blocks',
  {
    ...businessFields(),
    pageId: uuid('page_id').notNull(),
    parentId: uuid('parent_id'),
    position: rank('position').notNull(),
    type: text('type').notNull(),
    schemaVersion: integer('schema_version').notNull(),
    content: jsonb('content').$type<JsonObject>().notNull(),
  },
  (t) => [
    unique('blocks_workspace_id_uq').on(t.workspaceId, t.id),
    unique('blocks_workspace_page_id_uq').on(t.workspaceId, t.pageId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.pageId],
      foreignColumns: [pages.workspaceId, pages.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.pageId, t.parentId],
      foreignColumns: [t.workspaceId, t.pageId, t.id],
    }),
    ...auditReferences(t),
    uniqueIndex('blocks_sibling_position_uq')
      .on(
        t.workspaceId,
        t.pageId,
        sql`coalesce(${t.parentId}, '00000000-0000-0000-0000-000000000000'::uuid)`,
        t.position,
      )
      .where(sql`${t.deletedAt} is null`),
    index('blocks_page_idx').on(t.workspaceId, t.pageId),
    index('blocks_trash_idx')
      .on(t.deletedAt)
      .where(sql`${t.deletedAt} is not null`),
    check('blocks_not_self_ck', sql`${t.parentId} is distinct from ${t.id}`),
    check('blocks_rank_ck', sql`${t.position} ~ '^[0-9A-Za-z]+$'`),
    check('blocks_version_ck', sql`${t.schemaVersion} > 0`),
    check('blocks_type_ck', sql`${t.type} ~ '^[a-z][a-z0-9-]*[.][a-z][a-z0-9-]*$'`),
    check('blocks_content_ck', sql`jsonb_typeof(${t.content}) = 'object'`),
    check('blocks_non_nil_ck', sql`${t.id} <> '00000000-0000-0000-0000-000000000000'::uuid`),
  ],
);

export function pageReference(workspaceId: AnyPgColumn, pageId: AnyPgColumn) {
  return foreignKey({
    columns: [workspaceId, pageId],
    foreignColumns: [pages.workspaceId, pages.id],
  }).onDelete('cascade');
}

// Derived projection: lifecycle follows the page, no independent soft deletion.
export const searchDocuments = pgTable(
  'search_documents',
  {
    workspaceId: uuid('workspace_id').notNull(),
    pageId: uuid('page_id').primaryKey(),
    plainText: text('plain_text').notNull(),
    pageVersion: bigint('page_version', { mode: 'number' }).notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
    vector: searchVector('vector').generatedAlwaysAs(
      sql`to_tsvector('simple'::regconfig, plain_text)`,
    ),
  },
  (t) => [
    pageReference(t.workspaceId, t.pageId),
    index('search_workspace_idx').on(t.workspaceId),
    index('search_vector_idx').using('gin', t.vector),
  ],
);
