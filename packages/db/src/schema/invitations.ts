import { sql } from 'drizzle-orm';
import { pgTable, uuid, text, primaryKey, foreignKey, check } from 'drizzle-orm/pg-core';
import { invitation } from './auth.ts';
import { pages } from './content.ts';
/** Intent only; no access before acceptance creates a membership-bound subject/grant. */
export const invitationPages = pgTable(
  'invitation_pages',
  {
    workspaceId: uuid('workspace_id').notNull(),
    invitationId: uuid('invitation_id').notNull(),
    pageId: uuid('page_id').notNull(),
    level: text('level').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.invitationId, t.pageId] }),
    foreignKey({
      columns: [t.workspaceId, t.invitationId],
      foreignColumns: [invitation.organizationId, invitation.id],
    }).onDelete('cascade'),
    // Preserve the intent through archival. Hard purge must close/remove invitations first;
    // silently dropping a root could otherwise produce a partial acceptance.
    foreignKey({
      columns: [t.workspaceId, t.pageId],
      foreignColumns: [pages.workspaceId, pages.id],
    }),
    check('invitation_pages_level_ck', sql`${t.level} in ('read','edit')`),
  ],
);
