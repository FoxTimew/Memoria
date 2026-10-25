import { createHmac, randomUUID } from 'node:crypto';
import { setTimeout as pause } from 'node:timers/promises';
import { normalizeIP } from '@better-auth/core/utils/ip';
import { sql } from 'drizzle-orm';
import type { Database, WriteTransaction } from '@memoria/db';

type Db = Database | WriteTransaction;
export const throttleKey = (secret: string, domain: string, value: string) =>
  createHmac('sha256', secret).update(`${domain}:${value}`).digest('hex');
export const accountKey = (secret: string, email: string) =>
  throttleKey(secret, 'account', email.trim().toLowerCase());
export const ipKey = (secret: string, path: string, ip: string) =>
  throttleKey(secret, `ip:${path}`, normalizeIP(ip, { ipv6Subnet: 64 }));
export const delaySeconds = (failures: number) =>
  failures < 5 ? 0 : Math.min(30, 2 ** Math.min(5, failures - 5));
export class Throttled extends Error {
  constructor(
    readonly retryAfter: number,
    readonly code = 'AUTH_RATE_LIMITED',
  ) {
    super(code);
  }
}
export function routeQuota(path: string): [number, number] {
  if (path === '/security/status') return [600, 60];
  // Read-only policy heartbeat: 50 people × 4 tabs × 15 polls/min plus headroom.
  if (path === '/security/cache-policy') return [3600, 60];
  if (path === '/sign-in/email') return [150, 60];
  if (
    path === '/sign-up/email' ||
    path === '/reset-password' ||
    path === '/security/request-password-reset'
  )
    return [100, 600];
  if (path === '/send-verification-email') return [150, 300];
  if (
    path.startsWith('/two-factor/') ||
    path.startsWith('/passkey/') ||
    path.startsWith('/security/') ||
    path === '/verify-password'
  )
    return [300, 60];
  return [600, 60];
}
/** Single atomic statement: refusals never move the fixed window or increment unboundedly. */
export async function consumeBucket(db: Db, key: string, max: number, seconds: number) {
  const result = await db.execute(sql`INSERT INTO auth_buckets(key,count,started_at,touched_at)
    VALUES(${key},1,clock_timestamp(),clock_timestamp()) ON CONFLICT(key) DO UPDATE SET
    count=CASE WHEN auth_buckets.started_at+${seconds}*interval '1 second'<=clock_timestamp() THEN 1 ELSE least(auth_buckets.count+1,${max + 1}) END,
    started_at=CASE WHEN auth_buckets.started_at+${seconds}*interval '1 second'<=clock_timestamp() THEN clock_timestamp() ELSE auth_buckets.started_at END,
    touched_at=clock_timestamp()
    RETURNING count, greatest(1,ceil(extract(epoch FROM started_at+${seconds}*interval '1 second'-clock_timestamp()))) AS retry`);
  const row = result.rows[0]!;
  return { allowed: Number(row.count) <= max, retry: Number(row.retry) };
}
export async function checkIp(db: Db, secret: string, path: string, ip: string) {
  const [max, seconds] = routeQuota(path);
  const result = await consumeBucket(db, ipKey(secret, path, ip), max, seconds);
  if (!result.allowed) throw new Throttled(result.retry);
}
function positiveEnv(name: string, fallback: number) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value < 1) throw new Error(`Invalid ${name}`);
  return value;
}
export async function emailBudget(db: Db, secret: string, type: string, email: string) {
  // Both counters count accepted requests, including unknown addresses. No account lookup.
  const key = throttleKey(secret, `email:${type}`, email.trim().toLowerCase());
  const short = await consumeBucket(db, `${key}:15m`, positiveEnv('AUTH_EMAIL_MAX_15M', 3), 900);
  if (!short.allowed) return false;
  return (await consumeBucket(db, `${key}:day`, positiveEnv('AUTH_EMAIL_MAX_DAY', 10), 86400))
    .allowed;
}
const admissionLock = (db: Db) => db.execute(sql`SELECT pg_advisory_xact_lock(91724004)`);
export interface Attempt {
  id: string;
  key: string;
  generation: number;
  readyAt: number;
  delay: number;
}
/** Globally bounded across API processes. The lock is held for SQL only, never for waiting/hash work. */
export async function admitAttempt(db: Database, key: string, lane: string): Promise<Attempt> {
  return db.transaction(async (tx) => {
    await admissionLock(tx);
    await tx.execute(sql`DELETE FROM auth_attempt_leases WHERE expires_at<=clock_timestamp()`);
    const counts = (
      await tx.execute(
        sql`SELECT count(*) AS total, count(*) FILTER(WHERE account_key=${key} AND lane=${lane}) AS own FROM auth_attempt_leases`,
      )
    ).rows[0]!;
    if (Number(counts.total) >= 128 || Number(counts.own) >= 8)
      throw new Throttled(1, 'AUTH_CAPACITY');
    const state = (
      await tx.execute(sql`INSERT INTO auth_attempt_accounts(key) VALUES(${key}) ON CONFLICT(key) DO UPDATE SET
      failures=CASE WHEN auth_attempt_accounts.started_at+interval '15 minutes'<=clock_timestamp() THEN 0 ELSE auth_attempt_accounts.failures END,
      generation=auth_attempt_accounts.generation+CASE WHEN auth_attempt_accounts.started_at+interval '15 minutes'<=clock_timestamp() THEN 1 ELSE 0 END,
      started_at=CASE WHEN auth_attempt_accounts.started_at+interval '15 minutes'<=clock_timestamp() THEN clock_timestamp() ELSE auth_attempt_accounts.started_at END,
      touched_at=clock_timestamp() RETURNING failures,generation`)
    ).rows[0]!;
    // Reservations prevent a parallel burst from bypassing the first five failures.
    const pending = Number(
      (
        await tx.execute(
          sql`SELECT count(*) AS n FROM auth_attempt_leases WHERE account_key=${key} AND generation=${Number(state.generation)}`,
        )
      ).rows[0]!.n,
    );
    const delay = delaySeconds(Number(state.failures) + pending);
    const id = randomUUID();
    const row = (
      await tx.execute(sql`INSERT INTO auth_attempt_leases(id,account_key,lane,generation,ready_at,expires_at)
      VALUES(${id}::uuid,${key},${lane},${Number(state.generation)},clock_timestamp()+${delay}*interval '1 second',clock_timestamp()+interval '2 minutes') RETURNING ready_at`)
    ).rows[0]!;
    return {
      id,
      key,
      generation: Number(state.generation),
      readyAt: new Date(String(row.ready_at)).getTime(),
      delay,
    };
  });
}
export async function waitAttempt(db: Database, attempt: Attempt, signal: AbortSignal) {
  // Relative timers do not depend on wall-clock skew between API hosts and PostgreSQL.
  if (attempt.delay > 0) await pause(attempt.delay * 1000, undefined, { signal });
  for (;;) {
    signal.throwIfAborted();
    const status = await db.transaction(async (tx) => {
      await admissionLock(tx);
      const own = (
        await tx.execute(
          sql`SELECT *, ready_at<=clock_timestamp() AS ready FROM auth_attempt_leases WHERE id=${attempt.id}::uuid AND expires_at>clock_timestamp()`,
        )
      ).rows[0];
      if (!own) throw new Throttled(1, 'AUTH_CAPACITY');
      if (!own.ready) return false;
      // Ready jobs are FIFO. Future arrivals cannot overtake an admitted, ready request.
      const ahead = (
        await tx.execute(sql`SELECT count(*) AS n FROM auth_attempt_leases WHERE expires_at>clock_timestamp() AND
        (started_at IS NOT NULL OR (ready_at<=clock_timestamp() AND sequence<${Number(own.sequence)}))`)
      ).rows[0]!;
      if (Number(ahead.n) >= 8) return false;
      await tx.execute(
        sql`UPDATE auth_attempt_leases SET started_at=clock_timestamp() WHERE id=${attempt.id}::uuid`,
      );
      return true;
    });
    if (status) return;
    await pause(50, undefined, { signal });
  }
}
export async function finishAttempt(db: Database, attempt: Attempt, failed: boolean) {
  await db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM auth_attempt_leases WHERE id=${attempt.id}::uuid`);
    if (failed) {
      const changed =
        await tx.execute(sql`UPDATE auth_attempt_accounts SET failures=least(failures+1,1000),touched_at=clock_timestamp()
        WHERE key=${attempt.key} AND generation=${attempt.generation} RETURNING failures`);
      // One incident on reaching the threshold, not an audit row per hostile attempt.
      if (Number(changed.rows[0]?.failures) === 5)
        await tx.execute(
          sql`INSERT INTO auth_security_events(action) VALUES('account_throttle_threshold')`,
        );
    }
  });
}
/** Only called after a complete authentication. Older in-flight failures cannot undo this reset. */
export async function resetAccountAttempts(db: Db, secret: string, userId: string) {
  const row = (await db.execute(sql`SELECT email FROM auth_users WHERE id=${userId}::uuid`))
    .rows[0];
  if (row)
    await db.execute(sql`UPDATE auth_attempt_accounts SET failures=0,generation=generation+1,started_at=clock_timestamp(),touched_at=clock_timestamp()
    WHERE key=${accountKey(secret, String(row.email))}`);
}
export async function purgeAuthCounters(db: Database) {
  const hours = positiveEnv('AUTH_COUNTER_RETENTION_HOURS', 24);
  return db.transaction(async (tx) => {
    await tx.execute(sql`DELETE FROM auth_attempt_leases WHERE expires_at<=clock_timestamp()`);
    await tx.execute(sql`DELETE FROM auth_recovery_challenges WHERE expires_at<=clock_timestamp()`);
    await tx.execute(sql`DELETE FROM auth_factor_challenges WHERE expires_at<=clock_timestamp()`);
    await tx.execute(
      sql`DELETE FROM auth_buckets WHERE touched_at<clock_timestamp()-${hours}*interval '1 hour'`,
    );
    await tx.execute(
      sql`DELETE FROM auth_attempt_accounts a WHERE touched_at<clock_timestamp()-${hours}*interval '1 hour' AND NOT EXISTS(SELECT 1 FROM auth_attempt_leases l WHERE l.account_key=a.key)`,
    );
    await tx.execute(
      sql`DELETE FROM auth_rate_limits WHERE last_request<extract(epoch FROM clock_timestamp()-${hours}*interval '1 hour')*1000`,
    );
  });
}
