import { sql } from 'drizzle-orm';
import {
  check,
  customType,
  foreignKey,
  pgTable,
  text,
  timestamp,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { organization, user } from './auth.ts';

export type JsonValue =
  null | string | number | boolean | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };
export const time = (name: string) => timestamp(name, { withTimezone: true });
export const rank = customType<{ data: string }>({ dataType: () => 'varchar(128) COLLATE "C"' });
export const searchVector = customType<{ data: string }>({ dataType: () => 'tsvector' });

// Stable audit actors survive account/key deletion; PII is held only in auth_users.
export const actors = pgTable(
  'actors',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: time('created_at').defaultNow().notNull(),
    anonymizedAt: time('anonymized_at'),
  },
  (t) => [
    unique('actors_workspace_id_uq').on(t.workspaceId, t.id),
    check('actors_kind_ck', sql`${t.kind} in ('user','api_key','system','anonymized')`),
  ],
);

export const businessFields = () => ({
  id: uuid('id').defaultRandom().primaryKey(),
  workspaceId: uuid('workspace_id')
    .notNull()
    .references(() => organization.id, { onDelete: 'cascade' }),
  createdBy: uuid('created_by'),
  updatedBy: uuid('updated_by'),
  createdAt: time('created_at').defaultNow().notNull(),
  updatedAt: time('updated_at').defaultNow().notNull(),
  deletedAt: time('deleted_at'),
});

export function auditReferences(table: {
  workspaceId: AnyPgColumn;
  createdBy: AnyPgColumn;
  updatedBy: AnyPgColumn;
}) {
  return [
    foreignKey({
      columns: [table.workspaceId, table.createdBy],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
    foreignKey({
      columns: [table.workspaceId, table.updatedBy],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
  ];
}
