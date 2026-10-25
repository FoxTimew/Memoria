import { createHash, randomBytes } from 'node:crypto';
import { and, eq, sql } from 'drizzle-orm';
import type { Database, WriteTransaction } from '@memoria/db';
import * as tables from '@memoria/db/schema';
import { symmetricEncrypt, symmetricDecrypt } from 'better-auth/crypto';

export type AuthDb = Database | WriteTransaction;
export const recoveryHash = (user: string, code: string) =>
  createHash('sha256').update(`${user}:${code}`).digest('hex');
export async function lockAccount(db: AuthDb, user: string) {
  await db.insert(tables.accountSecurity).values({ userId: user }).onConflictDoNothing();
  await db.execute(
    sql`SELECT user_id FROM account_security WHERE user_id=${user}::uuid FOR UPDATE`,
  );
  await db.execute(
    sql`SELECT id FROM auth_sessions WHERE user_id=${user}::uuid ORDER BY id FOR UPDATE`,
  );
}
export async function queueAuthMail(
  db: AuthDb,
  secret: string,
  kind: 'password-request' | 'delivery',
  payload: object,
  userId?: string,
  expiresAt = new Date(Date.now() + 1800000),
) {
  await db.insert(tables.authMailJobs).values({
    kind,
    userId,
    expiresAt,
    payload: await symmetricEncrypt({ key: secret, data: JSON.stringify(payload) }),
  });
}
export const readMailPayload = async (secret: string, payload: string) =>
  JSON.parse(await symmetricDecrypt({ key: secret, data: payload })) as {
    email: string;
    subject?: string;
    text?: string;
  };
export async function securityNotice(db: AuthDb, secret: string, user: string, text: string) {
  const [account] = await db.select().from(tables.user).where(eq(tables.user.id, user));
  if (account?.emailVerified)
    await queueAuthMail(
      db,
      secret,
      'delivery',
      { email: account.email, subject: 'Sécurité de votre compte — Memoria', text },
      user,
      new Date(Date.now() + 86400000),
    );
}
/** Caller holds account/session locks. All effects roll back with the surrounding transaction. */
export async function revokeForRecovery(db: AuthDb, user: string, required: boolean) {
  await db
    .update(tables.accountSecurity)
    .set({ version: sql`${tables.accountSecurity.version}+1`, recoveryRequired: required })
    .where(eq(tables.accountSecurity.userId, user));
  await db.delete(tables.session).where(eq(tables.session.userId, user));
  await db.delete(tables.operatorRecovery).where(eq(tables.operatorRecovery.userId, user));
  // Native password reset grants carry the user ID; session-bound challenges cascade.
  await db.delete(tables.verification).where(eq(tables.verification.value, user));
}
export const factorTarget = /^(totp|all|passkey:[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12})$/i;
export async function removeFactor(db: AuthDb, user: string, target: string) {
  if (!factorTarget.test(target)) throw new Error('INVALID_FACTOR_TARGET');
  let affected = 0;
  if (target === 'all' || target === 'totp') {
    affected += (
      await db.delete(tables.twoFactor).where(eq(tables.twoFactor.userId, user)).returning()
    ).length;
    await db.update(tables.user).set({ twoFactorEnabled: false }).where(eq(tables.user.id, user));
    await db
      .update(tables.accountSecurity)
      .set({ lastTotpStep: -1 })
      .where(eq(tables.accountSecurity.userId, user));
  }
  if (target === 'all' || target.startsWith('passkey:'))
    affected += (
      await db
        .delete(tables.passkey)
        .where(
          target === 'all'
            ? eq(tables.passkey.userId, user)
            : and(eq(tables.passkey.userId, user), eq(tables.passkey.id, target.slice(8))),
        )
        .returning()
    ).length;
  if (!affected) throw new Error('FACTOR_NOT_FOUND');
  await db.execute(sql`UPDATE account_security s SET recovery_pending_factors=ARRAY(
    SELECT id FROM auth_passkeys WHERE user_id=${user}::uuid AND id=ANY(s.recovery_pending_factors)
    UNION ALL SELECT id FROM auth_two_factors WHERE user_id=${user}::uuid AND id=ANY(s.recovery_pending_factors)) WHERE s.user_id=${user}::uuid`);
}
export async function operatorReset(
  db: Database,
  options: {
    userId: string;
    factor: string;
    reason: string;
    operator: string;
    apply: boolean;
    confirm?: string;
    secret: string;
    origin: string;
  },
) {
  const parsedOrigin = URL.parse(options.origin);
  if (!parsedOrigin || parsedOrigin.protocol !== 'https:' || parsedOrigin.origin !== options.origin)
    throw new Error('HTTPS_ORIGIN_REQUIRED');
  if (
    !/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(options.userId) ||
    !factorTarget.test(options.factor)
  )
    throw new Error('INVALID_TARGET');
  if (
    !options.reason.trim() ||
    options.reason.length > 500 ||
    !options.operator.trim() ||
    options.operator.length > 150
  )
    throw new Error('REASON_AND_OPERATOR_REQUIRED');
  if (options.apply && options.confirm !== options.userId)
    throw new Error('EXACT_USER_CONFIRMATION_REQUIRED');
  return db.transaction(async (tx) => {
    const [user] = await tx.select().from(tables.user).where(eq(tables.user.id, options.userId));
    if (!user?.emailVerified) throw new Error('VERIFIED_ACCOUNT_REQUIRED');
    if (options.apply) await lockAccount(tx, options.userId);
    const keys = await tx
      .select({ id: tables.passkey.id, name: tables.passkey.name })
      .from(tables.passkey)
      .where(eq(tables.passkey.userId, user.id));
    const totp = await tx
      .select({ id: tables.twoFactor.id })
      .from(tables.twoFactor)
      .where(eq(tables.twoFactor.userId, user.id));
    const [prior] = await tx
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, user.id));
    const reissue =
      options.factor === 'all' && !keys.length && !totp.length && prior?.recoveryRequired === true;
    if (
      (options.factor === 'totp' && !totp.length) ||
      (options.factor.startsWith('passkey:') &&
        !keys.some((key) => key.id === options.factor.slice(8))) ||
      (options.factor === 'all' && !keys.length && !totp.length && !reissue)
    )
      throw new Error('FACTOR_NOT_FOUND');
    const result = {
      userId: user.id,
      email: user.email,
      factor: options.factor,
      passkeys: keys,
      totp: !!totp.length,
      applied: options.apply,
    };
    if (!options.apply) return result;
    if (!reissue) await removeFactor(tx, user.id, options.factor);
    await revokeForRecovery(tx, user.id, true);
    await tx.delete(tables.recoveryCodes).where(eq(tables.recoveryCodes.userId, user.id));
    const [state] = await tx
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, user.id));
    const token = randomBytes(32).toString('base64url');
    await tx.insert(tables.operatorRecovery).values({
      userId: user.id,
      hash: recoveryHash(user.id, token),
      securityVersion: state!.version,
      expiresAt: new Date(Date.now() + 1800000),
    });
    await tx.insert(tables.authSecurityEvents).values({
      userId: user.id,
      action: reissue ? 'operator_recovery_reissued' : 'operator_factor_reset',
      operator: options.operator,
      reason: options.reason,
      target: options.factor,
    });
    await queueAuthMail(
      tx,
      options.secret,
      'delivery',
      {
        email: user.email,
        subject: 'Rétablir vos facteurs — Memoria',
        text: `Une récupération a été demandée par l’exploitant. Avec votre mot de passe, ouvrez ce lien sous trente minutes :\n${options.origin}/recuperation#operator=${token}\nSi vous n’êtes pas à l’origine de cette demande, contactez votre exploitant.`,
      },
      user.id,
    );
    return result;
  });
}
