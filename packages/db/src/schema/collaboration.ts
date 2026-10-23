import { sql } from 'drizzle-orm';
import {
  bigint,
  check,
  customType,
  foreignKey,
  index,
  integer,
  jsonb,
  numeric,
  pgTable,
  primaryKey,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { actors, time } from './common.ts';
import { pages } from './content.ts';
const binary = customType<{ data: Buffer; driverData: Buffer }>({ dataType: () => 'bytea' });
const revision = (name: string) => bigint(name, { mode: 'number' }).notNull().default(0);
export const collaborationDocuments = pgTable(
  'collaboration_documents',
  {
    pageId: uuid('page_id').primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    generation: uuid('generation').defaultRandom().notNull(),
    snapshot: binary('snapshot').notNull(),
    snapshotRevision: revision('snapshot_revision'),
    contentRevision: revision('content_revision'),
    projectionRevision: revision('projection_revision'),
    journalBytes: bigint('journal_bytes', { mode: 'number' }).default(0).notNull(),
    projectionFirstPendingAt: time('projection_first_pending_at'),
    projectionDueAt: time('projection_due_at'),
    projectionRetryAt: time('projection_retry_at'),
    projectionAttempts: integer('projection_attempts').default(0).notNull(),
    encodedBytes: integer('encoded_bytes').notNull(),
    businessBytes: integer('business_bytes').notNull(),
    metricsRevision: revision('metrics_revision'),
    historyRatio: numeric('history_ratio').generatedAlwaysAs(
      sql`encoded_bytes::numeric / greatest(business_bytes, 1)`,
    ),
    historyWarningAt: time('history_warning_at'),
    compactedAt: time('compacted_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (t) => [
    unique('collab_document_scope_uq').on(t.workspaceId, t.pageId, t.generation),
    foreignKey({
      columns: [t.workspaceId, t.pageId],
      foreignColumns: [pages.workspaceId, pages.id],
    }).onDelete('cascade'),
    check('collab_snapshot_size_ck', sql`octet_length(${t.snapshot}) between 2 and 1048576`),
    check(
      'collab_revisions_ck',
      sql`${t.snapshotRevision} >= 0 and ${t.projectionRevision} >= 0 and ${t.metricsRevision} >= 0 and ${t.contentRevision} between greatest(${t.snapshotRevision},${t.projectionRevision},${t.metricsRevision}) and 9007199254740991`,
    ),
    check(
      'collab_sizes_ck',
      sql`${t.encodedBytes} between 2 and 1048576 and ${t.businessBytes} between 2 and 1048576 and ${t.journalBytes} >= 0 and ${t.projectionAttempts} >= 0`,
    ),
    index('collab_projection_due_idx')
      .on(t.projectionDueAt)
      .where(sql`${t.projectionDueAt} is not null`),
  ],
);
export const collaborationUpdates = pgTable(
  'collaboration_updates',
  {
    workspaceId: uuid('workspace_id').notNull(),
    pageId: uuid('page_id').notNull(),
    generation: uuid('generation').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    update: binary('update').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.generation, t.revision] }),
    foreignKey({
      columns: [t.workspaceId, t.pageId, t.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.pageId,
        collaborationDocuments.generation,
      ],
    }).onDelete('cascade'),
    check('collab_update_size_ck', sql`octet_length(${t.update}) between 2 and 1048576`),
    check('collab_update_revision_ck', sql`${t.revision} between 1 and 9007199254740991`),
  ],
);
export const collaborationReceipts = pgTable(
  'collaboration_receipts',
  {
    workspaceId: uuid('workspace_id').notNull(),
    pageId: uuid('page_id').notNull(),
    generation: uuid('generation').notNull(),
    actorId: uuid('actor_id').notNull(),
    receipt: uuid('receipt').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    updateHash: text('update_hash').notNull(),
    requestHash: text('request_hash'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.generation, t.actorId, t.receipt] }),
    foreignKey({
      columns: [t.workspaceId, t.pageId, t.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.pageId,
        collaborationDocuments.generation,
      ],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
    check(
      'collab_receipt_hash_ck',
      sql`${t.updateHash} ~ '^[a-f0-9]{64}$' and (${t.requestHash} is null or ${t.requestHash} ~ '^[a-f0-9]{64}$')`,
    ),
    check('collab_receipt_revision_ck', sql`${t.revision} between 0 and 9007199254740991`),
    index('collab_receipt_revision_idx').on(t.pageId, t.generation, t.revision),
  ],
);
export const collaborationLeadership = pgTable(
  'collaboration_leadership',
  {
    id: integer('id').primaryKey().default(1),
    owner: uuid('owner').notNull(),
    epoch: bigint('epoch', { mode: 'number' }).notNull(),
    backendPid: integer('backend_pid').notNull(),
    leaseUntil: time('lease_until').notNull(),
  },
  (t) => [check('collab_leader_singleton_ck', sql`${t.id}=1 and ${t.epoch}>0`)],
);
export const collaborationNonces = pgTable(
  'collaboration_nonces',
  {
    nonce: uuid('nonce').primaryKey(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [index('collab_nonce_expiry_idx').on(t.expiresAt)],
);
// Durable effect marker: prevents duplicate audit/outbox across retries and restarts.
export const collaborationProjectionCommits = pgTable(
  'collaboration_projection_commits',
  {
    workspaceId: uuid('workspace_id').notNull(),
    pageId: uuid('page_id').notNull(),
    generation: uuid('generation').notNull(),
    revision: bigint('revision', { mode: 'number' }).notNull(),
    eventId: uuid('event_id').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    details: jsonb('details').$type<{ authors: number }>().notNull(),
  },
  (t) => [
    primaryKey({ columns: [t.pageId, t.generation, t.revision] }),
    foreignKey({
      columns: [t.workspaceId, t.pageId, t.generation],
      foreignColumns: [
        collaborationDocuments.workspaceId,
        collaborationDocuments.pageId,
        collaborationDocuments.generation,
      ],
    }).onDelete('cascade'),
  ],
);

// Reserve IDs at journal commit, before the asynchronous block projection exists.
export const collaborationBlockIds = pgTable(
  'collaboration_block_ids',
  {
    id: uuid('id').primaryKey(),
    pageId: uuid('page_id')
      .notNull()
      .references(() => pages.id, { onDelete: 'cascade' }),
  },
  (t) => [index('collab_block_ids_page_idx').on(t.pageId)],
);
