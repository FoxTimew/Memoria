import {
  bigserial,
  check,
  index,
  integer,
  pgTable,
  text,
  timestamp,
  uuid,
} from 'drizzle-orm/pg-core';
import { sql } from 'drizzle-orm';

const time = (name: string) => timestamp(name, { withTimezone: true });
// Keys are domain-separated HMACs; never store an address, IP or credential here.
export const authBuckets = pgTable(
  'auth_buckets',
  {
    key: text('key').primaryKey(),
    count: integer('count').notNull(),
    startedAt: time('started_at').notNull(),
    touchedAt: time('touched_at').notNull(),
  },
  (t) => [index('auth_buckets_cleanup_idx').on(t.touchedAt)],
);
export const authAttemptAccounts = pgTable(
  'auth_attempt_accounts',
  {
    key: text('key').primaryKey(),
    failures: integer('failures').default(0).notNull(),
    generation: integer('generation').default(0).notNull(),
    startedAt: time('started_at').defaultNow().notNull(),
    touchedAt: time('touched_at').defaultNow().notNull(),
  },
  (t) => [index('auth_accounts_cleanup_idx').on(t.touchedAt)],
);
export const authAttemptLeases = pgTable(
  'auth_attempt_leases',
  {
    id: uuid('id').primaryKey(),
    sequence: bigserial('sequence', { mode: 'number' }).notNull(),
    accountKey: text('account_key').notNull(),
    lane: text('lane').notNull(),
    generation: integer('generation').notNull(),
    readyAt: time('ready_at').notNull(),
    expiresAt: time('expires_at').notNull(),
    startedAt: time('started_at'),
  },
  (t) => [
    index('auth_leases_account_idx').on(t.accountKey),
    index('auth_leases_expiry_idx').on(t.expiresAt),
  ],
);
export const authRecoveryChallenges = pgTable(
  'auth_recovery_challenges',
  {
    id: uuid('id').defaultRandom().primaryKey(),
    accountKey: text('account_key').notNull(),
    purpose: text('purpose').notNull(),
    attempts: integer('attempts').default(0).notNull(),
    expiresAt: time('expires_at').notNull(),
  },
  (t) => [
    index('auth_recovery_challenges_expiry_idx').on(t.expiresAt),
    check('auth_recovery_challenges_attempts_ck', sql`${t.attempts} between 0 and 5`),
  ],
);
