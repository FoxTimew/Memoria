import { APIError } from 'better-auth';
import { createAuthEndpoint, sessionMiddleware } from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import * as tables from '@memoria/db/schema';
import type { AuthDb } from './recovery-core.ts';
import {
  lockAccount,
  queueAuthMail,
  recoveryHash,
  removeFactor,
  revokeForRecovery,
  securityNotice,
  factorTarget,
} from './recovery-core.ts';
import type { Identity, SecurityFlow } from './security-plugin.ts';
type Context = Parameters<typeof setSessionCookie>[0];
const denied = (code = 'RECOVERY_DENIED') => new APIError('FORBIDDEN', { code, message: code });
export function recoveryEndpoints(
  db: AuthDb,
  secret: string,
  flow: SecurityFlow | undefined,
  identity: (ctx: Context) => Promise<Identity>,
  codes: (user: string) => Promise<string[]>,
) {
  async function limited(ctx: Context) {
    const value = await identity(ctx);
    if (!flow?.recovering) throw denied('RECOVERY_SESSION_REQUIRED');
    return value;
  }
  const requestBody = z.strictObject({
    email: z.email().max(254),
    password: z.string().min(1).max(128),
    code: z.string().min(1).max(128),
  });
  const consume = (operator: boolean) =>
    createAuthEndpoint(
      operator ? '/security/operator-recover' : '/security/recover',
      { method: 'POST', body: requestBody },
      async (ctx) => {
        if (!flow) throw denied('SECURITY_TRANSACTION_REQUIRED');
        const email = ctx.body.email.trim().toLowerCase();
        const [user] = await db
          .select()
          .from(tables.user)
          .where(sql`lower(${tables.user.email})=${email}`);
        if (!user?.emailVerified) {
          await ctx.context.password.hash(ctx.body.password);
          throw denied();
        }
        await lockAccount(db, user.id);
        const [account] = await db
          .select()
          .from(tables.account)
          .where(
            and(eq(tables.account.userId, user.id), eq(tables.account.providerId, 'credential')),
          );
        if (
          !account?.password ||
          !(await ctx.context.password.verify({
            hash: account.password,
            password: ctx.body.password,
          }))
        )
          throw denied();
        const code = operator ? ctx.body.code : ctx.body.code.replace(/[\s-]/g, '').toLowerCase();
        const hash = recoveryHash(user.id, code);
        const result = operator
          ? await db.execute(
              sql`UPDATE auth_operator_recovery SET consumed_at=clock_timestamp() WHERE user_id=${user.id}::uuid AND hash=${hash} AND consumed_at IS NULL AND expires_at>clock_timestamp() AND security_version=(SELECT version FROM account_security WHERE user_id=${user.id}::uuid) RETURNING id`,
            )
          : await db.execute(
              sql`UPDATE auth_recovery_codes SET consumed_at=clock_timestamp() WHERE user_id=${user.id}::uuid AND hash=${hash} AND consumed_at IS NULL RETURNING id`,
            );
        if (result.rows.length !== 1) throw denied();
        await revokeForRecovery(db, user.id, true);
        const created = await ctx.context.internalAdapter.createSession(user.id);
        if (!created) throw new Error('RECOVERY_SESSION_CREATION_FAILED');
        const expiresAt = new Date(Date.now() + 900000);
        await db.update(tables.session).set({ expiresAt }).where(eq(tables.session.id, created.id));
        const [state] = await db
          .select()
          .from(tables.accountSecurity)
          .where(eq(tables.accountSecurity.userId, user.id));
        await db.insert(tables.sessionAssurance).values({
          sessionId: created.id,
          method: 'recovery',
          verifiedAt: new Date(),
          securityVersion: state!.version,
        });
        await db
          .insert(tables.sessionSecurity)
          .values({ sessionId: created.id, sharedComputer: true, passwordVerifiedAt: new Date() });
        await db.insert(tables.authSecurityEvents).values({
          userId: user.id,
          action: operator ? 'operator_recovery_started' : 'recovery_code_consumed',
        });
        await securityNotice(
          db,
          secret,
          user.id,
          'Une récupération de vos facteurs a commencé. Vos anciennes sessions sont fermées. Si cette action n’est pas la vôtre, contactez votre exploitant.',
        );
        await setSessionCookie(ctx, {
          session: { ...created, expiresAt },
          user: (await ctx.context.internalAdapter.findUserById(user.id)) as Identity['user'],
        });
        return ctx.json({ status: true, recovery: true, expiresAt });
      },
    );
  return {
    requestRecoveryEmail: createAuthEndpoint(
      '/security/request-password-reset',
      { method: 'POST', body: z.strictObject({ email: z.email().max(254) }) },
      async (ctx) => {
        if (!flow) throw denied('SECURITY_TRANSACTION_REQUIRED');
        // No account lookup or SMTP in the public response path, including unknown addresses.
        await queueAuthMail(db, secret, 'password-request', {
          email: ctx.body.email.trim().toLowerCase(),
        });
        return ctx.json({
          status: true,
          message: 'Si cette adresse correspond à un compte vérifié, vous recevrez un email.',
        });
      },
    ),
    recoverWithCode: consume(false),
    recoverWithOperator: consume(true),
    recoveryRemoveFactor: createAuthEndpoint(
      '/security/recovery-remove-factor',
      {
        method: 'POST',
        use: [sessionMiddleware],
        body: z.strictObject({ factor: z.string().regex(factorTarget) }),
      },
      async (ctx) => {
        const value = await limited(ctx);
        // Validate target before effects; API 4xx must never commit a partial mutation.
        const exists =
          ctx.body.factor === 'totp'
            ? (
                await db
                  .select()
                  .from(tables.twoFactor)
                  .where(eq(tables.twoFactor.userId, value.user.id))
              ).length
            : ctx.body.factor === 'all'
              ? (
                  await db.execute(
                    sql`SELECT id FROM auth_passkeys WHERE user_id=${value.user.id}::uuid UNION ALL SELECT id FROM auth_two_factors WHERE user_id=${value.user.id}::uuid`,
                  )
                ).rows.length
              : (
                  await db
                    .select()
                    .from(tables.passkey)
                    .where(
                      and(
                        eq(tables.passkey.userId, value.user.id),
                        eq(tables.passkey.id, ctx.body.factor.slice(8)),
                      ),
                    )
                ).length;
        if (!exists) throw denied('FACTOR_NOT_FOUND');
        await removeFactor(db, value.user.id, ctx.body.factor);
        await db
          .update(tables.sessionSecurity)
          .set({ recoveryFactorId: null })
          .where(eq(tables.sessionSecurity.sessionId, value.session.id));
        await db.insert(tables.authSecurityEvents).values({
          userId: value.user.id,
          action: 'recovery_factor_removed',
          target: ctx.body.factor,
        });
        return ctx.json({ status: true });
      },
    ),
    recoveryFinish: createAuthEndpoint(
      '/security/recovery-finish',
      { method: 'POST', use: [sessionMiddleware], body: z.strictObject({}) },
      async (ctx) => {
        const value = await limited(ctx);
        const [settings] = await db
          .select()
          .from(tables.sessionSecurity)
          .where(eq(tables.sessionSecurity.sessionId, value.session.id));
        const valid = await db.execute(
          sql`SELECT id FROM auth_passkeys WHERE user_id=${value.user.id}::uuid AND id=${settings?.recoveryFactorId ?? null}::uuid UNION ALL SELECT id FROM auth_two_factors WHERE user_id=${value.user.id}::uuid AND id=${settings?.recoveryFactorId ?? null}::uuid AND verified`,
        );
        if (!valid.rows.length) throw denied('NEW_FACTOR_REQUIRED');
        const recoveryCodes = await codes(value.user.id);
        await db
          .update(tables.accountSecurity)
          .set({ recoveryPendingFactors: [] })
          .where(eq(tables.accountSecurity.userId, value.user.id));
        await revokeForRecovery(db, value.user.id, true);
        const created = await ctx.context.internalAdapter.createSession(value.user.id);
        if (!created) throw new Error('RECOVERY_SESSION_CREATION_FAILED');
        await db
          .insert(tables.sessionSecurity)
          .values({ sessionId: created.id, sharedComputer: settings?.sharedComputer ?? true });
        await db
          .insert(tables.authSecurityEvents)
          .values({ userId: value.user.id, action: 'recovery_completed' });
        await securityNotice(
          db,
          secret,
          value.user.id,
          'Vos nouveaux facteurs sont configurés. Les anciens codes de secours sont remplacés. Une nouvelle vérification de votre identité est nécessaire pour ouvrir vos espaces.',
        );
        await setSessionCookie(ctx, { session: created, user: value.user });
        return ctx.json({ status: true, requiresStrongAuth: true, recoveryCodes });
      },
    ),
  };
}
