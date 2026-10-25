import { sql } from 'drizzle-orm';
import { check, foreignKey, integer, pgTable, primaryKey, text, uuid } from 'drizzle-orm/pg-core';
import { member, organization } from './auth.ts';

/** Transactionally derived effective permissions. Versions change only for changed pairs.
 * Deleted pages keep a tombstone until the membership/workspace is deleted. */
export const pageAccessState = pgTable(
  'page_access_state',
  {
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    memberId: uuid('member_id').notNull(),
    pageId: uuid('page_id').notNull(),
    level: text('level').notNull(),
    version: integer('version').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.workspaceId, t.memberId, t.pageId] }),
    foreignKey({
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.organizationId, member.id],
    }).onDelete('cascade'),
    check('page_access_state_level_ck', sql`${t.level} in ('none','read','edit')`),
    check('page_access_state_version_ck', sql`${t.version} > 0`),
  ],
);

/** Coalesces all tree/grant/role changes in one transaction; empty after commit. */
export const pageAccessPending = pgTable('page_access_pending', {
  workspaceId: uuid('workspace_id')
    .primaryKey()
    .references(() => organization.id, { onDelete: 'cascade' }),
});
