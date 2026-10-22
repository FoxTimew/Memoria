import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  foreignKey,
  index,
  integer,
  jsonb,
  pgEnum,
  pgTable,
  text,
  unique,
  uuid,
} from 'drizzle-orm/pg-core';
import { organization } from './auth.ts';
import { actors, auditReferences, businessFields, time } from './common.ts';
import type { JsonObject } from './common.ts';

export const domainEventType = pgEnum('domain_event_type', [
  'page.created',
  'page.updated',
  'block.updated',
  'database.row.created',
  'database.row.updated',
]);

// Append-only technical records expire by retention, not by soft delete.
export const outboxEvents = pgTable(
  'outbox_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    type: domainEventType('type').notNull(),
    schemaVersion: integer('schema_version').default(1).notNull(),
    actorId: uuid('actor_id'),
    aggregateId: uuid('aggregate_id').notNull(),
    aggregateVersion: bigint('aggregate_version', { mode: 'number' }).notNull(),
    payload: jsonb('payload').$type<JsonObject>().notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
    availableAt: time('available_at').defaultNow().notNull(),
    claimedUntil: time('claimed_until'),
    publishedAt: time('published_at'),
    materializedAt: time('materialized_at'),
    attempts: integer('attempts').default(0).notNull(),
  },
  (t) => [
    unique('outbox_workspace_id_uq').on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
    index('outbox_pending_idx')
      .on(t.availableAt, t.createdAt)
      .where(sql`${t.publishedAt} is null`),
    index('outbox_retention_idx').on(t.publishedAt),
  ],
);

export const webhookEndpoints = pgTable(
  'webhook_endpoints',
  {
    ...businessFields(),
    url: text('url').notNull(),
    description: text('description'),
    enabled: boolean('enabled').default(true).notNull(),
    events: domainEventType('events').array().notNull(),
    secretCiphertext: text('secret_ciphertext').notNull(),
    secretKeyVersion: integer('secret_key_version').default(1).notNull(),
    previousSecretCiphertext: text('previous_secret_ciphertext'),
    previousSecretExpiresAt: time('previous_secret_expires_at'),
    consecutiveFailures: integer('consecutive_failures').default(0).notNull(),
    disabledAt: time('disabled_at'),
  },
  (t) => [
    unique('webhooks_workspace_id_uq').on(t.workspaceId, t.id),
    check('webhooks_events_ck', sql`cardinality(${t.events}) > 0`),
    ...auditReferences(t),
  ],
);

export const webhookDeliveries = pgTable(
  'webhook_deliveries',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    endpointId: uuid('endpoint_id').notNull(),
    eventId: uuid('event_id').notNull(),
    status: text('status').default('pending').notNull(),
    attemptCount: integer('attempt_count').default(0).notNull(),
    nextAttemptAt: time('next_attempt_at').defaultNow().notNull(),
    claimedUntil: time('claimed_until'),
    deliveredAt: time('delivered_at'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
  },
  (t) => [
    unique('deliveries_workspace_id_uq').on(t.workspaceId, t.id),
    unique('deliveries_event_endpoint_uq').on(t.workspaceId, t.eventId, t.endpointId),
    foreignKey({
      columns: [t.workspaceId, t.endpointId],
      foreignColumns: [webhookEndpoints.workspaceId, webhookEndpoints.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.eventId],
      foreignColumns: [outboxEvents.workspaceId, outboxEvents.id],
    }),
    check(
      'deliveries_status_ck',
      sql`${t.status} in ('pending','delivering','succeeded','exhausted','canceled')`,
    ),
    index('deliveries_due_idx').on(t.status, t.nextAttemptAt),
  ],
);

export const webhookAttempts = pgTable(
  'webhook_attempts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id').notNull(),
    deliveryId: uuid('delivery_id').notNull(),
    attemptNumber: integer('attempt_number').notNull(),
    httpStatus: integer('http_status'),
    errorCode: text('error_code'),
    startedAt: time('started_at').defaultNow().notNull(),
    finishedAt: time('finished_at'),
    durationMs: integer('duration_ms'),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.deliveryId],
      foreignColumns: [webhookDeliveries.workspaceId, webhookDeliveries.id],
    }).onDelete('cascade'),
    unique('attempt_number_uq').on(t.deliveryId, t.attemptNumber),
  ],
);

export const auditLogs = pgTable(
  'audit_logs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id'),
    action: text('action').notNull(),
    resourceType: text('resource_type').notNull(),
    resourceId: uuid('resource_id'),
    // Allowlisted non-PII metadata only. No emails, names, IPs, bodies or credentials.
    metadata: jsonb('metadata').$type<JsonObject>().default({}).notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
    index('audit_workspace_time_idx').on(t.workspaceId, t.createdAt, t.id),
  ],
);

export const idempotencyRecords = pgTable(
  'idempotency_records',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    workspaceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    actorId: uuid('actor_id').notNull(),
    route: text('route').notNull(),
    keyHash: text('key_hash').notNull(),
    requestHash: text('request_hash').notNull(),
    status: text('status').default('in_progress').notNull(),
    responseStatus: integer('response_status'),
    responseCiphertext: text('response_ciphertext'),
    createdAt: time('created_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
    unique('idempotency_scope_uq').on(t.workspaceId, t.actorId, t.route, t.keyHash),
    check('idempotency_status_ck', sql`${t.status} in ('in_progress','completed')`),
    index('idempotency_expiry_idx').on(t.expiresAt),
  ],
);
