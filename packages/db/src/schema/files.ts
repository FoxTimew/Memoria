import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { auditReferences, businessFields, time } from './common.ts';
import { blocks, pages, pageReference } from './content.ts';
import { organization, user, session } from './auth.ts';
import { collaborationDocuments } from './collaboration.ts';

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
    everAttached: boolean('ever_attached').default(false).notNull(),
    orphanedAt: time('orphaned_at'),
    storageDeletedAt: time('storage_deleted_at'),
  },
  (t) => [
    unique('files_workspace_id_uq').on(t.workspaceId, t.id),
    unique('files_object_key_uq').on(t.objectKey),
    check('files_size_ck', sql`${t.byteSize} between 0 and 9007199254740991`),
    check(
      'files_state_ck',
      sql`${t.state} in ('pending','reserved','uploading','completing','validating','ready','rejected','deleting','deleted')`,
    ),
    index('files_cleanup_idx').on(t.state, t.uploadExpiresAt),
    ...auditReferences(t),
  ],
);

// Authoritative ledger; no FK to the asynchronous blocks projection.
export const fileUsages = pgTable(
  'file_usages',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    fileId: uuid('file_id').notNull(),
    pageId: uuid('page_id').notNull(),
    slotKind: text('slot_kind').notNull(),
    slotId: uuid('slot_id').notNull(),
    generation: uuid('generation'),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
  },
  (t) => [
    unique().on(t.workspaceId, t.pageId, t.slotKind, t.slotId, t.fileId),
    foreignKey({
      columns: [t.workspaceId, t.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }),
    pageReference(t.workspaceId, t.pageId),
    check('file_usages_kind_ck', sql`${t.slotKind} in ('block','cell')`),
    check('file_usages_revision_ck', sql`${t.revision}>=0`),
    check('file_usages_generation_ck', sql`(${t.slotKind}='block')=(${t.generation} is not null)`),
    index('file_usages_source_idx').on(t.workspaceId, t.fileId, t.pageId),
  ],
);
export const fileLedgerStates = pgTable(
  'file_ledger_states',
  {
    pageId: uuid('page_id')
      .primaryKey()
      .references(() => collaborationDocuments.pageId, { onDelete: 'cascade' }),
    generation: uuid('generation').notNull(),
    revision: bigint('revision', { mode: 'bigint' }).notNull(),
  },
  (t) => [check('file_ledger_revision_ck', sql`${t.revision}>=0`)],
);
export const fileWorkspaceUsage = pgTable(
  'file_workspace_usage',
  {
    workspaceId: uuid('workspace_id')
      .primaryKey()
      .references(() => organization.id, { onDelete: 'cascade' }),
    reservedBytes: bigint('reserved_bytes', { mode: 'bigint' }).default(0n).notNull(),
    filesCount: integer('files_count').default(0).notNull(),
  },
  (t) => [
    check('file_workspace_bytes_ck', sql`${t.reservedBytes}>=0`),
    check('file_workspace_count_ck', sql`${t.filesCount}>=0`),
  ],
);
export const fileUploadIntents = pgTable(
  'file_upload_intents',
  {
    fileId: uuid('file_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    pageId: uuid('page_id').notNull(),
    idempotencyKey: uuid('idempotency_key').notNull(),
    requestedBytes: bigint('requested_bytes', { mode: 'bigint' }).notNull(),
    reservedBytes: bigint('reserved_bytes', { mode: 'bigint' }).notNull(),
    requestHash: text('request_hash').notNull(),
    createdAt: time('created_at')
      .default(sql`clock_timestamp()`)
      .notNull(),
    expiresAt: time('expires_at').notNull(),
    absoluteExpiresAt: time('absolute_expires_at').notNull(),
    attachUntil: time('attach_until'),
    closedAt: time('closed_at'),
    transportMode: text('transport_mode'),
    stagingKey: text('staging_key'),
    finalKey: text('final_key').unique(),
    uploadId: text('upload_id'),
    sessionId: uuid('session_id').references(() => session.id, { onDelete: 'set null' }),
    wholeChecksum: text('whole_checksum'),
    bytesVerifiedAt: time('bytes_verified_at'),
    stagingCleanedAt: time('staging_cleaned_at'),
    nextAttemptAt: time('next_attempt_at')
      .default(sql`clock_timestamp()`)
      .notNull(),
    attempts: integer('attempts').default(0).notNull(),
    lastError: text('last_error'),
    jobEpoch: bigint('job_epoch', { mode: 'bigint' }).default(0n).notNull(),
  },
  (t) => [
    unique().on(t.userId, t.idempotencyKey),
    foreignKey({
      columns: [t.workspaceId, t.fileId],
      foreignColumns: [files.workspaceId, files.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.pageId],
      foreignColumns: [pages.workspaceId, pages.id],
    }),
    check(
      'file_intent_bytes_ck',
      sql`${t.requestedBytes}>0 and ${t.reservedBytes}>=${t.requestedBytes}`,
    ),
    index('file_uploads_active_idx')
      .on(t.userId, t.expiresAt)
      .where(sql`${t.closedAt} is null`),
    index('file_transport_job_idx').on(t.nextAttemptAt),
    check('file_transport_mode_ck', sql`${t.transportMode} in ('post','multipart')`),
  ],
);
export const fileAdmissionBuckets = pgTable(
  'file_admission_buckets',
  {
    userId: uuid('user_id')
      .primaryKey()
      .references(() => user.id, { onDelete: 'cascade' }),
    tokens: numeric('tokens').notNull(),
    updatedAt: time('updated_at').notNull(),
  },
  (t) => [check('file_admission_tokens_ck', sql`${t.tokens}>=0`)],
);
export const filePartLeases = pgTable(
  'file_part_leases',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id),
    fileId: uuid('file_id')
      .notNull()
      .references(() => fileUploadIntents.fileId),
    requestId: uuid('request_id').notNull(),
    partNumber: integer('part_number').notNull(),
    bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
    checksum: text('checksum').notNull(),
    expiresAt: time('expires_at').notNull(),
    reconciledAt: time('reconciled_at'),
  },
  (t) => [
    unique().on(t.userId, t.requestId, t.partNumber),
    check('file_part_number_ck', sql`${t.partNumber} between 1 and 10000`),
    check('file_part_bytes_ck', sql`${t.bytes}>0`),
    index('file_part_leases_expiry_idx').on(t.expiresAt),
  ],
);

export const filePartPlans = pgTable(
  'file_part_plans',
  {
    fileId: uuid('file_id')
      .notNull()
      .references(() => fileUploadIntents.fileId),
    partNumber: integer('part_number').notNull(),
    bytes: bigint('bytes', { mode: 'bigint' }).notNull(),
    checksum: text('checksum').notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.fileId, t.partNumber] }),
    check('file_plan_part_ck', sql`${t.partNumber} between 1 and 10000`),
    check('file_plan_bytes_ck', sql`${t.bytes}>0`),
  ],
);
export const fileObjectCopies = pgTable('file_object_copies', {
  objectKey: text('object_key').primaryKey(),
  fileId: uuid('file_id')
    .notNull()
    .references(() => fileUploadIntents.fileId),
  epoch: bigint('epoch', { mode: 'bigint' }).notNull(),
  createdAt: time('created_at')
    .default(sql`clock_timestamp()`)
    .notNull(),
  deletedAt: time('deleted_at'),
});

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
