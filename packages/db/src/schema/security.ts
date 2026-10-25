import { sql } from 'drizzle-orm';
import {
  boolean,
  check,
  foreignKey,
  index,
  integer,
  pgTable,
  text,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';
import { member, organization } from './auth.ts';
import { actors, auditReferences, businessFields, time } from './common.ts';
import { pages } from './content.ts';

export const workspacePolicies = pgTable(
  'workspace_policies',
  {
    ...businessFields(),
    requireStrongAuth: boolean('require_strong_auth').default(false).notNull(),
    strongAuthEnabledAt: time('strong_auth_enabled_at'),
    graceDays: integer('grace_days').default(7).notNull(),
    securityVersion: integer('security_version').default(1).notNull(),
    allowPersistentCache: boolean('allow_persistent_cache').default(true).notNull(),
    trashRetentionDays: integer('trash_retention_days').default(30).notNull(),
    eventRetentionDays: integer('event_retention_days').default(30).notNull(),
    deliveryRetentionDays: integer('delivery_retention_days').default(30).notNull(),
    auditRetentionDays: integer('audit_retention_days').default(90).notNull(),
  },
  (t) => [
    unique('policies_workspace_uq').on(t.workspaceId),
    ...auditReferences(t),
    check(
      'policies_retention_ck',
      sql`${t.graceDays} between 0 and 30 and ${t.securityVersion} > 0 and ${t.trashRetentionDays} > 0 and ${t.eventRetentionDays} > 0 and ${t.deliveryRetentionDays} > 0 and ${t.auditRetentionDays} > 0`,
    ),
  ],
);

// Auth credential lifecycle is plugin-owned. Issuer/policy fields are server-only.
export const apikey = pgTable(
  'api_keys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    referenceId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    configId: text('config_id').default('public-v1').notNull(),
    name: text('name'),
    start: text('start'),
    prefix: text('prefix'),
    key: text('key_hash').notNull().unique(),
    refillInterval: integer('refill_interval'),
    refillAmount: integer('refill_amount'),
    lastRefillAt: time('last_refill_at'),
    enabled: boolean('enabled').default(true).notNull(),
    rateLimitEnabled: boolean('rate_limit_enabled').default(true).notNull(),
    rateLimitTimeWindow: integer('rate_limit_time_window').default(60000),
    rateLimitMax: integer('rate_limit_max').default(120),
    requestCount: integer('request_count').default(0).notNull(),
    remaining: integer('remaining'),
    lastRequest: time('last_used_at'),
    expiresAt: time('expires_at'),
    createdAt: time('created_at').defaultNow().notNull(),
    updatedAt: time('updated_at').defaultNow().notNull(),
    permissions: text('permissions'),
    metadata: text('metadata'),
  },
  (t) => [
    unique('api_keys_workspace_id_uq').on(t.referenceId, t.id),
    index('api_keys_workspace_idx').on(t.referenceId),
  ],
);

// Sidecar persists after the plugin purges a credential; credentialId is nullable.
export const apiKeyPolicies = pgTable(
  'api_key_policies',
  {
    ...businessFields(),
    credentialId: uuid('credential_id')
      .unique()
      .references(() => apikey.id, { onDelete: 'set null' }),
    actorId: uuid('actor_id').notNull(),
    issuerMemberId: uuid('issuer_member_id'),
    revokedAt: time('revoked_at'),
    displayPrefix: text('display_prefix').notNull(),
  },
  (t) => [
    unique('key_policies_workspace_id_uq').on(t.workspaceId, t.id),
    unique('key_policies_actor_uq').on(t.workspaceId, t.actorId),
    foreignKey({
      columns: [t.workspaceId, t.actorId],
      foreignColumns: [actors.workspaceId, actors.id],
    }),
    foreignKey({
      columns: [t.workspaceId, t.issuerMemberId],
      foreignColumns: [member.organizationId, member.id],
    }),
    ...auditReferences(t),
  ],
);

// Generic subjects/resources, concrete FK columns keep tenant integrity in SQL.
export const accessSubjects = pgTable(
  'access_subjects',
  {
    ...businessFields(),
    kind: text('kind').notNull(),
    memberId: uuid('member_id'),
    apiKeyPolicyId: uuid('api_key_policy_id'),
  },
  (t) => [
    unique('subjects_workspace_id_uq').on(t.workspaceId, t.id),
    foreignKey({
      columns: [t.workspaceId, t.memberId],
      foreignColumns: [member.organizationId, member.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.apiKeyPolicyId],
      foreignColumns: [apiKeyPolicies.workspaceId, apiKeyPolicies.id],
    }).onDelete('cascade'),
    unique('subjects_member_uq').on(t.workspaceId, t.memberId),
    unique('subjects_key_uq').on(t.workspaceId, t.apiKeyPolicyId),
    check(
      'subjects_kind_ck',
      sql`(${t.kind} = 'member' and ${t.memberId} is not null and ${t.apiKeyPolicyId} is null) or (${t.kind} = 'api_key' and ${t.apiKeyPolicyId} is not null and ${t.memberId} is null)`,
    ),
    ...auditReferences(t),
  ],
);

export const accessGrants = pgTable(
  'access_grants',
  {
    ...businessFields(),
    subjectId: uuid('subject_id').notNull(),
    resourceType: text('resource_type').default('page').notNull(),
    resourceId: uuid('resource_id').notNull(),
    level: text('level').notNull(),
    inherit: boolean('inherit').default(true).notNull(),
  },
  (t) => [
    foreignKey({
      columns: [t.workspaceId, t.subjectId],
      foreignColumns: [accessSubjects.workspaceId, accessSubjects.id],
    }).onDelete('cascade'),
    foreignKey({
      columns: [t.workspaceId, t.resourceId],
      foreignColumns: [pages.workspaceId, pages.id],
    }).onDelete('cascade'),
    uniqueIndex('grants_live_uq')
      .on(t.workspaceId, t.subjectId, t.resourceType, t.resourceId)
      .where(sql`${t.deletedAt} is null`),
    index('grants_resource_idx').on(t.workspaceId, t.resourceId),
    check('grants_resource_ck', sql`${t.resourceType} = 'page'`),
    check('grants_level_ck', sql`${t.level} in ('read','edit')`),
    ...auditReferences(t),
  ],
);
