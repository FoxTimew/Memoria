import { sql } from 'drizzle-orm';
import {
  bigint,
  boolean,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  unique,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

const time = (name: string) => timestamp(name, { withTimezone: true });
const times = () => ({
  createdAt: time('created_at').defaultNow().notNull(),
  updatedAt: time('updated_at').defaultNow().notNull(),
});

// Better Auth property names are preserved; SQL names follow snake_case.
export const user = pgTable(
  'auth_users',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    name: text('name').notNull(),
    email: text('email').notNull(),
    emailVerified: boolean('email_verified').default(false).notNull(),
    image: text('image'),
    twoFactorEnabled: boolean('two_factor_enabled').default(false).notNull(),
    ...times(),
  },
  (t) => [uniqueIndex('users_email_normalized_uq').on(sql`lower(${t.email})`)],
);

export const organization = pgTable('workspaces', {
  id: uuid('id').defaultRandom().primaryKey(),
  name: text('name').notNull(),
  slug: text('slug').notNull().unique(),
  logo: text('logo'),
  metadata: text('metadata'),
  ...times(),
  deletedAt: time('deleted_at'),
});

export const session = pgTable(
  'auth_sessions',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    token: text('token').notNull().unique(),
    expiresAt: time('expires_at').notNull(),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    activeOrganizationId: uuid('active_workspace_id').references(() => organization.id, {
      onDelete: 'set null',
    }),
    ...times(),
  },
  (t) => [index('sessions_user_idx').on(t.userId), index('sessions_expiry_idx').on(t.expiresAt)],
);

export const account = pgTable(
  'auth_accounts',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountId: text('account_id').notNull(),
    providerId: text('provider_id').notNull(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    accessToken: text('access_token'),
    refreshToken: text('refresh_token'),
    idToken: text('id_token'),
    accessTokenExpiresAt: time('access_token_expires_at'),
    refreshTokenExpiresAt: time('refresh_token_expires_at'),
    scope: text('scope'),
    password: text('password'),
    ...times(),
  },
  (t) => [
    unique('accounts_provider_subject_uq').on(t.providerId, t.accountId),
    index('accounts_user_idx').on(t.userId),
  ],
);

export const verification = pgTable(
  'auth_verifications',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    identifier: text('identifier').notNull(),
    value: text('value').notNull(),
    expiresAt: time('expires_at').notNull(),
    ...times(),
  },
  (t) => [
    index('verifications_identifier_idx').on(t.identifier),
    index('verifications_expiry_idx').on(t.expiresAt),
  ],
);

export const member = pgTable(
  'workspace_members',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    role: text('role').default('member').notNull(),
    ...times(),
    mfaDeadline: time('mfa_deadline'),
  },
  (t) => [
    unique('members_workspace_user_uq').on(t.organizationId, t.userId),
    unique('members_workspace_id_uq').on(t.organizationId, t.id),
    check('members_role_ck', sql`${t.role} in ('owner','admin','member','guest')`),
    index('members_user_idx').on(t.userId),
  ],
);

export const invitation = pgTable(
  'workspace_invitations',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    organizationId: uuid('workspace_id')
      .notNull()
      .references(() => organization.id, { onDelete: 'cascade' }),
    email: text('email').notNull(),
    role: text('role'),
    status: text('status').default('pending').notNull(),
    closedAt: time('closed_at'),
    deliveryStatus: text('delivery_status').default('not-sent').notNull(),
    inviterId: uuid('inviter_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    expiresAt: time('expires_at').notNull(),
    ...times(),
  },
  (t) => [
    index('invitations_workspace_idx').on(t.organizationId),
    index('invitations_email_idx').on(t.email),
    index('invitations_expiry_idx').on(t.expiresAt),
    unique('invitations_workspace_id_uq').on(t.organizationId, t.id),
    uniqueIndex('invitations_pending_email_uq')
      .on(t.organizationId, sql`lower(${t.email})`)
      .where(sql`${t.status}='pending'`),
    check(
      'invitation_role_ck',
      sql`${t.role} is null or ${t.role} in ('owner','admin','member','guest')`,
    ),
  ],
);

export const twoFactor = pgTable('auth_two_factors', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .unique()
    .references(() => user.id, { onDelete: 'cascade' }),
  secret: text('secret').notNull(),
  backupCodes: text('backup_codes').notNull(),
  verified: boolean('verified').default(true).notNull(),
  failedVerificationCount: integer('failed_verification_count').default(0).notNull(),
  lockedUntil: time('locked_until'),
});

export const passkey = pgTable(
  'auth_passkeys',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    name: text('name'),
    publicKey: text('public_key').notNull(),
    credentialID: text('credential_id').notNull().unique(),
    counter: bigint('counter', { mode: 'number' }).notNull(),
    deviceType: text('device_type').notNull(),
    backedUp: boolean('backed_up').notNull(),
    transports: text('transports'),
    createdAt: time('created_at').defaultNow(),
    aaguid: text('aaguid'),
  },
  (t) => [index('passkeys_user_idx').on(t.userId)],
);

export const rateLimit = pgTable('auth_rate_limits', {
  id: uuid('id').defaultRandom().primaryKey(),
  key: text('key').notNull().unique(),
  count: integer('count').notNull(),
  lastRequest: bigint('last_request', { mode: 'number' }).notNull(),
});

// Only the server records assurance after successful cryptographic verification.
export const sessionAssurance = pgTable(
  'session_assurance',
  {
    sessionId: uuid('session_id')
      .primaryKey()
      .references(() => session.id, { onDelete: 'cascade' }),
    method: text('method').notNull(),
    verifiedAt: time('verified_at').notNull(),
    securityVersion: integer('security_version').default(0).notNull(),
    factorId: uuid('factor_id'),
  },
  (t) => [check('assurance_method_ck', sql`${t.method} in ('totp','passkey','recovery')`)],
);

export const accountSecurity = pgTable('account_security', {
  userId: uuid('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  version: integer('version').default(0).notNull(),
  lastTotpStep: bigint('last_totp_step', { mode: 'number' }).default(-1).notNull(),
  recoveryRequired: boolean('recovery_required').default(false).notNull(),
  recoveryPendingFactors: uuid('recovery_pending_factors')
    .array()
    .default(sql`'{}'::uuid[]`)
    .notNull(),
});

export const sessionSecurity = pgTable('session_security', {
  sessionId: uuid('session_id')
    .primaryKey()
    .references(() => session.id, { onDelete: 'cascade' }),
  passwordVerifiedAt: time('password_verified_at'),
  sharedComputer: boolean('shared_computer').default(false).notNull(),
  recoveryFactorId: uuid('recovery_factor_id'),
});

export const factorChallenges = pgTable(
  'auth_factor_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    sessionId: uuid('session_id')
      .notNull()
      .references(() => session.id, { onDelete: 'cascade' }),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    purpose: text('purpose').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    expiresAt: time('expires_at').notNull(),
    consumedAt: time('consumed_at'),
  },
  (t) => [
    index('factor_challenges_session_idx').on(t.sessionId),
    check('factor_challenge_attempts_ck', sql`${t.attempts} between 0 and 5`),
    check('factor_challenge_purpose_ck', sql`${t.purpose} in ('totp-enroll','totp-auth')`),
  ],
);

export const recoveryCodes = pgTable(
  'auth_recovery_codes',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    hash: text('hash').notNull().unique(),
    createdAt: time('created_at').defaultNow().notNull(),
    consumedAt: time('consumed_at'),
  },
  (t) => [index('recovery_codes_user_idx').on(t.userId)],
);

export const authSecurityEvents = pgTable(
  'auth_security_events',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'set null' }),
    action: text('action').notNull(),
    operator: text('operator'),
    reason: text('reason'),
    target: text('target'),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (t) => [index('auth_security_events_created_idx').on(t.createdAt)],
);

export const operatorRecovery = pgTable('auth_operator_recovery', {
  id: uuid('id').defaultRandom().primaryKey(),
  userId: uuid('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  hash: text('hash').notNull().unique(),
  securityVersion: integer('security_version').notNull(),
  expiresAt: time('expires_at').notNull(),
  consumedAt: time('consumed_at'),
});

// Only encrypted recipients/links are retained while delivery is pending.
export const authMailJobs = pgTable(
  'auth_mail_jobs',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    userId: uuid('user_id').references(() => user.id, { onDelete: 'cascade' }),
    kind: text('kind').notNull(),
    invitationId: uuid('invitation_id').references(() => invitation.id, { onDelete: 'cascade' }),
    payload: text('payload').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    availableAt: time('available_at').defaultNow().notNull(),
    expiresAt: time('expires_at').notNull(),
    createdAt: time('created_at').defaultNow().notNull(),
  },
  (t) => [
    index('auth_mail_available_idx').on(t.availableAt),
    check(
      'auth_mail_kind_ck',
      sql`${t.kind} in ('password-request','verification-request','delivery','invitation')`,
    ),
  ],
);
