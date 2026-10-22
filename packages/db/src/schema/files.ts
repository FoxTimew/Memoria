import { sql } from 'drizzle-orm';
import { bigint, check, foreignKey, index, pgTable, text, unique, uuid } from 'drizzle-orm/pg-core';
import { auditReferences, businessFields, time } from './common.ts';
import { blocks, pageReference } from './content.ts';

export const files = pgTable(
  'files',
  {
    ...businessFields(),
    objectKey: text('object_key').notNull(),
    originalName: text('original_name').notNull(),
    mimeType: text('mime_type').notNull(),
    byteSize: bigint('byte_size', { mode: 'number' }).notNull(),
    sha256: text('sha256'),
    state: text('state').default('pending').notNull(),
    uploadExpiresAt: time('upload_expires_at'),
  },
  (t) => [
    unique('files_workspace_id_uq').on(t.workspaceId, t.id),
    unique('files_object_key_uq').on(t.objectKey),
    check('files_size_ck', sql`${t.byteSize} between 0 and 9007199254740991`),
    check('files_state_ck', sql`${t.state} in ('pending','ready','deleting')`),
    index('files_cleanup_idx').on(t.state, t.uploadExpiresAt),
    ...auditReferences(t),
  ],
);

export const fileReferences = pgTable(
  'file_references',
  {
    ...businessFields(),
    fileId: uuid('file_id').notNull(),
    pageId: uuid('page_id').notNull(),
    blockId: uuid('block_id'),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }).onDelete('cascade'),
    pageReference(t.workspaceId, t.pageId),
    foreignKey({
      columns: [t.workspaceId, t.pageId, t.blockId],
      foreignColumns: [blocks.workspaceId, blocks.pageId, blocks.id],
    }).onDelete('cascade'),
    index('file_refs_page_idx').on(t.workspaceId, t.pageId),
    index('file_refs_file_idx').on(t.workspaceId, t.fileId),
    ...auditReferences(t),
  ],
);
