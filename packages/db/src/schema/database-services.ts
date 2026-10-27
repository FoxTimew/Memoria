import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, bigint, primaryKey, foreignKey, index } from 'drizzle-orm/pg-core';
import { time, searchVector } from './common.ts';
import { organization } from './auth.ts';
import { databaseRows } from './databases.ts';

export const databaseCounters = pgTable(
  'database_counters',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    scope: text('scope').notNull(),
    resourceId: uuid('resource_id').notNull(),
    used: bigint('used', { mode: 'bigint' })
      .notNull()
      .default(sql`0`),
  },
  (t) => [primaryKey({ columns: [t.workspaceId, t.scope, t.resourceId] })],
);

export const databaseCreateReceipts = pgTable(
  'database_create_receipts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    databaseId: uuid('database_id').notNull(),
    actorId: uuid('actor_id').notNull(),
    receipt: uuid('receipt').notNull(),
    requestHash: text('request_hash').notNull(),
    rowPageId: uuid('row_page_id').notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.databaseId, t.actorId, t.receipt] }),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.rowPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.databaseId, databaseRows.pageId],
    }).onDelete('cascade'),
    index('database_create_receipts_expiry_idx').on(t.expiresAt),
  ],
);

export const databaseRowSearch = pgTable(
  'database_row_search',
  {
    workspaceId: uuid('workspace_id').notNull(),
    databaseId: uuid('database_id').notNull(),
    rowPageId: uuid('row_page_id').notNull(),
    relationalText: text('relational_text').notNull().default(''),
    bodyText: text('body_text').notNull().default(''),
    vector: searchVector('vector').generatedAlwaysAs(
      sql`to_tsvector('simple',relational_text || '\n' || body_text)`,
    ),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.rowPageId] }),
    foreignKey({
      columns: [t.workspaceId, t.databaseId, t.rowPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.databaseId, databaseRows.pageId],
    }).onDelete('cascade'),
    index('database_row_search_vector_idx').using('gin', t.vector),
  ],
);

export const databaseRowAuthors = pgTable(
  'database_row_authors',
  {
    workspaceId: uuid('workspace_id').notNull(),
    rowPageId: uuid('row_page_id').notNull(),
    actorId: uuid('actor_id').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.rowPageId, t.actorId] }),
    foreignKey({
      columns: [t.workspaceId, t.rowPageId],
      foreignColumns: [databaseRows.workspaceId, databaseRows.pageId],
    }).onDelete('cascade'),
  ],
);
