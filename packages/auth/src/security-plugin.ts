import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';
import { and, eq, ne, sql } from 'drizzle-orm';
import { APIError } from 'better-auth';
import {
  createAuthEndpoint,
  createAuthMiddleware,
  getSessionFromCtx,
  sessionMiddleware,
} from 'better-auth/api';
import { setSessionCookie } from 'better-auth/cookies';
import { symmetricDecrypt } from 'better-auth/crypto';
import { twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { createOTP } from '@better-auth/utils/otp';
import { z } from 'zod';
import * as tables from '@memoria/db/schema';
import type { Database, WriteTransaction } from '@memoria/db';
import { readAssurance } from './assurance.ts';
import { lockAccount, securityNotice, revokeForRecovery } from './recovery-core.ts';
import { recoveryEndpoints } from './recovery-plugin.ts';
import { resetAccountAttempts } from './throttle.ts';

type Context = Parameters<typeof getSessionFromCtx>[0];
export type Identity = NonNullable<Awaited<ReturnType<typeof getSessionFromCtx>>>;
export interface SecurityFlow {
  sharedComputer?: boolean;
  initial?: Identity | null;
  initialSettings?: typeof tables.sessionSecurity.$inferSelect;
  lockedUser?: string;
  firstFactor?: boolean;
  step?: number;
  factorId?: string;
  enrolling?: boolean;
  recovering?: boolean;
  recoveryExpiry?: Date;
  challenge?: string;
  expectedUser?: string;
  proof?: { userId: string; factorId: string; method: 'passkey' | 'totp' };
}

const denied = (code: string) => new APIError('FORBIDDEN', { code, message: code });
const protectedPaths = new Set([
  '/verify-password',
  '/two-factor/enable',
  '/two-factor/disable',
  '/two-factor/verify-totp',
  '/passkey/generate-register-options',
  '/passkey/verify-registration',
  '/passkey/generate-authenticate-options',
  '/passkey/verify-authentication',
  '/passkey/delete-passkey',
  '/passkey/update-passkey',
  '/reset-password',
]);

/** Per-request hooks: the HTTP adapter constructs this inside one SQL transaction.
 * Native TOTP encryption/verification and WebAuthn cryptography remain library-owned.
 * Password sessions with an active factor are challenges, never content sessions.
 */
export function securityIntegration(
  db: Database | WriteTransaction,
  origin: string,
  flow?: SecurityFlow,
  secret = '',
) {
  async function factors(userId: string) {
    const [totp] = await db
      .select()
      .from(tables.twoFactor)
      .where(eq(tables.twoFactor.userId, userId));
    const keys = await db.select().from(tables.passkey).where(eq(tables.passkey.userId, userId));
    return { totp, keys, active: totp?.verified === true || keys.length > 0 };
  }
  async function lock(userId: string) {
    if (flow?.lockedUser === userId) return;
    if (flow?.lockedUser) throw denied('IDENTITY_CHANGED');
    await lockAccount(db, userId);
    if (flow) flow.lockedUser = userId;
  }
  async function identity(ctx: Context) {
    const value = await getSessionFromCtx(ctx);
    if (!value?.user.emailVerified) throw denied('SESSION_REQUIRED');
    await lock(value.user.id);
    const alive = await db
      .select({ id: tables.session.id })
      .from(tables.session)
      .where(
        and(
          eq(tables.session.id, value.session.id),
          sql`${tables.session.expiresAt}>clock_timestamp()`,
        ),
      );
    if (!alive.length) throw denied('SESSION_REVOKED');
    // Native TOTP enrollment may delete the old session (and its sidecar) before after-hooks.
    const [settings] = await db
      .select()
      .from(tables.sessionSecurity)
      .where(eq(tables.sessionSecurity.sessionId, value.session.id));
    if (flow && settings) flow.initialSettings ??= settings;
    const [assurance] = await db
      .select()
      .from(tables.sessionAssurance)
      .where(eq(tables.sessionAssurance.sessionId, value.session.id));
    const [state] = await db
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, value.user.id));
    if (assurance?.method === 'recovery' && assurance.securityVersion !== state?.version)
      throw denied('SESSION_REVOKED');
    if (flow) flow.recovering = assurance?.method === 'recovery';
    if (flow?.recovering) flow.recoveryExpiry = new Date(value.session.expiresAt);
    return value;
  }
  async function fresh(value: Identity) {
    if (!(await readAssurance(db, value.session.id)).recent)
      throw denied('RECENT_STRONG_AUTH_REQUIRED');
  }
  async function factorReady(userId: string, factorId: string) {
    const [state] = await db
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, userId));
    if (state?.recoveryPendingFactors.includes(factorId)) throw denied('RECOVERY_FINISH_REQUIRED');
  }
  async function enrollment(value: Identity) {
    if (flow?.recovering) return;
    const [state] = await db
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, value.user.id));
    if (state?.recoveryRequired) throw denied('RECOVERY_REQUIRED');
    const existing = await factors(value.user.id);
    if (flow) flow.firstFactor = !existing.active;
    if (existing.active) return fresh(value);
    const [confirmation] = await db
      .select()
      .from(tables.sessionSecurity)
      .where(eq(tables.sessionSecurity.sessionId, value.session.id));
    if (
      !confirmation?.passwordVerifiedAt ||
      Date.now() - confirmation.passwordVerifiedAt.getTime() >= 300000
    )
      throw denied('RECENT_PASSWORD_REQUIRED');
  }
  async function audit(userId: string, action: string) {
    await db.insert(tables.authSecurityEvents).values({ userId, action });
  }
  async function codes(userId: string) {
    const values = Array.from({ length: 10 }, () => randomBytes(16).toString('hex'));
    await db.delete(tables.recoveryCodes).where(eq(tables.recoveryCodes.userId, userId));
    await db.insert(tables.recoveryCodes).values(
      values.map((code) => ({
        userId,
        hash: createHash('sha256').update(`${userId}:${code}`).digest('hex'),
      })),
    );
    await audit(userId, 'recovery_codes_generated');
    return values;
  }
  async function changed(userId: string, keepSession?: string) {
    await db
      .update(tables.accountSecurity)
      .set({ version: sql`${tables.accountSecurity.version}+1` })
      .where(eq(tables.accountSecurity.userId, userId));
    await db
      .delete(tables.session)
      .where(
        keepSession
          ? and(eq(tables.session.userId, userId), ne(tables.session.id, keepSession))
          : eq(tables.session.userId, userId),
      );
    if (keepSession)
      await db
        .delete(tables.sessionAssurance)
        .where(eq(tables.sessionAssurance.sessionId, keepSession));
    if (keepSession && flow?.recovering) {
      const [state] = await db
        .select()
        .from(tables.accountSecurity)
        .where(eq(tables.accountSecurity.userId, userId));
      await db.insert(tables.sessionAssurance).values({
        sessionId: keepSession,
        method: 'recovery',
        verifiedAt: new Date(),
        securityVersion: state!.version,
      });
    }
    await audit(userId, 'factors_changed');
  }
  async function recordProof(sessionId: string, proof: NonNullable<SecurityFlow['proof']>) {
    if (flow?.recovering) throw denied('RECOVERY_FINISH_REQUIRED');
    const previous = flow?.initial?.session.id;
    const [settings] = previous
      ? await db
          .select()
          .from(tables.sessionSecurity)
          .where(eq(tables.sessionSecurity.sessionId, previous))
      : [];
    const [before] = await db
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, proof.userId));
    if (before?.recoveryRequired) {
      await db
        .update(tables.accountSecurity)
        .set({ recoveryRequired: false, version: sql`${tables.accountSecurity.version}+1` })
        .where(eq(tables.accountSecurity.userId, proof.userId));
      await db
        .delete(tables.session)
        .where(and(eq(tables.session.userId, proof.userId), ne(tables.session.id, sessionId)));
      await db
        .delete(tables.operatorRecovery)
        .where(eq(tables.operatorRecovery.userId, proof.userId));
    }
    const [security] = await db
      .select()
      .from(tables.accountSecurity)
      .where(eq(tables.accountSecurity.userId, proof.userId));
    const [current] = await db
      .select()
      .from(tables.session)
      .where(eq(tables.session.id, sessionId));
    if (!current || current.userId !== proof.userId || !security)
      throw denied('PROOF_SESSION_MISMATCH');
    await db.insert(tables.sessionAssurance).values({
      sessionId,
      method: proof.method,
      verifiedAt: new Date(),
      factorId: proof.factorId,
      securityVersion: security.version,
    });
    if (previous && previous !== sessionId) {
      const preserved = flow?.initialSettings ?? settings;
      if (preserved) await db.insert(tables.sessionSecurity).values({ ...preserved, sessionId });
      await db.delete(tables.session).where(eq(tables.session.id, previous));
    } else if (!previous) {
      await db
        .insert(tables.sessionSecurity)
        .values({ sessionId, sharedComputer: flow?.sharedComputer === true });
    }
    await resetAccountAttempts(db, secret, proof.userId);
    await audit(proof.userId, 'strong_session_verified');
  }

  const nativeTotp = twoFactor({
    issuer: 'Memoria',
    twoFactorCookieMaxAge: 300,
    accountLockout: { enabled: false },
    totpOptions: { digits: 6, period: 30 },
  });
  // Replace native sign-in interception with one content boundary for TOTP AND passkeys.
  // The native cookie challenge is not exposed; our pending session cannot access content.
  const totpPlugin = { ...nativeTotp, hooks: { after: [] } };
  const passkeyPlugin = passkey({
    rpName: 'Memoria',
    rpID: new URL(origin).hostname,
    origin,
    authenticatorSelection: { userVerification: 'required' },
    registration: {
      requireSession: true,
      afterVerification: async ({ verification, user }) => {
        if (!flow || !verification.verified || verification.registrationInfo?.userVerified !== true)
          throw denied('USER_VERIFICATION_REQUIRED');
        if (flow.initial?.user.id !== user.id) throw denied('IDENTITY_CHANGED');
      },
    },
    authentication: {
      afterVerification: async ({ verification, clientData }) => {
        if (
          !flow ||
          !verification.verified ||
          verification.authenticationInfo.userVerified !== true
        )
          throw denied('USER_VERIFICATION_REQUIRED');
        const [key] = await db
          .select()
          .from(tables.passkey)
          .where(eq(tables.passkey.credentialID, clientData.id));
        if (!key || (flow.expectedUser && key.userId !== flow.expectedUser))
          throw denied('IDENTITY_CHANGED');
        const [user] = await db.select().from(tables.user).where(eq(tables.user.id, key.userId));
        if (!user?.emailVerified) throw denied('EMAIL_NOT_VERIFIED');
        flow.proof = { userId: key.userId, factorId: key.id, method: 'passkey' };
      },
    },
  });

  const hooks = {
    before: createAuthMiddleware(async (ctx) => {
      const path = ctx.path ?? '';
      if (!protectedPaths.has(path) && !path.startsWith('/security/')) return;
      if (!flow) throw denied('SECURITY_TRANSACTION_REQUIRED');
      if (
        [
          '/security/request-password-reset',
          '/security/recover',
          '/security/operator-recover',
        ].includes(path)
      )
        return;
      if (path === '/reset-password') {
        if (ctx.query?.token || typeof ctx.body?.token !== 'string' || ctx.body.token.length > 256)
          throw denied('INVALID_TOKEN');
        const token = await ctx.context.internalAdapter.findVerificationValue(
          `reset-password:${ctx.body.token}`,
        );
        if (!token || token.expiresAt <= new Date()) throw denied('INVALID_TOKEN');
        await lock(token.value);
        return;
      }
      flow.initial = await getSessionFromCtx(ctx);
      if (ctx.body?.trustDevice === true || ctx.body?.createSession === true)
        throw denied('UNSUPPORTED_AUTH_MODE');
      if (typeof ctx.body?.name === 'string' && ctx.body.name.length > 100)
        throw denied('INVALID_FACTOR_NAME');
      if (path === '/passkey/generate-authenticate-options') return;
      if (path === '/passkey/verify-authentication') {
        const cookie = ctx.context.createAuthCookie('better-auth-passkey');
        const token = await ctx.getSignedCookie(cookie.name, ctx.context.secret);
        const challenge = token
          ? await ctx.context.internalAdapter.findVerificationValue(token)
          : null;
        if (!challenge || challenge.expiresAt <= new Date()) throw denied('CHALLENGE_EXPIRED');
        const saved = JSON.parse(challenge.value) as { type: string; userData?: { id?: string } };
        if (saved.type !== 'authentication') throw denied('CHALLENGE_INTENT_MISMATCH');
        if (saved.userData?.id && flow.initial?.user.id !== saved.userData.id)
          throw denied('IDENTITY_CHANGED');
        flow.expectedUser = flow.initial?.user.id ?? saved.userData?.id ?? '';
        const credential = ctx.body?.response?.id;
        if (typeof credential !== 'string') throw denied('INVALID_CREDENTIAL');
        const [key] = await db
          .select()
          .from(tables.passkey)
          .where(eq(tables.passkey.credentialID, credential));
        if (!key) throw denied('INVALID_CREDENTIAL');
        await lock(key.userId);
        await factorReady(key.userId, key.id);
        if (flow.initial) await identity(ctx);
        if (flow.recovering) throw denied('RECOVERY_FINISH_REQUIRED');
        if (flow.expectedUser && flow.expectedUser !== key.userId) throw denied('IDENTITY_CHANGED');
        return;
      }
      const value = await identity(ctx);
      flow.initial = value;
      if (
        flow.recovering &&
        ![
          '/security/status',
          '/security/cache-policy',
          '/security/challenge',
          '/security/recovery-remove-factor',
          '/security/recovery-finish',
          '/verify-password',
          '/two-factor/enable',
          '/two-factor/verify-totp',
          '/passkey/generate-register-options',
          '/passkey/verify-registration',
        ].includes(path)
      )
        throw denied('RECOVERY_SESSION_RESTRICTED');
      if (
        [
          '/two-factor/enable',
          '/passkey/generate-register-options',
          '/passkey/verify-registration',
        ].includes(path)
      ) {
        await enrollment(value);
        if (path === '/two-factor/enable' && ctx.body?.method && ctx.body.method !== 'totp')
          throw denied('UNSUPPORTED_AUTH_MODE');
      }
      if (
        [
          '/two-factor/disable',
          '/passkey/delete-passkey',
          '/passkey/update-passkey',
          '/security/recovery-codes',
        ].includes(path)
      )
        await fresh(value);
      if (path === '/two-factor/disable' || path === '/passkey/delete-passkey') {
        const memberships = await db
          .select({ workspace: tables.member.organizationId })
          .from(tables.member)
          .where(eq(tables.member.userId, value.user.id))
          .orderBy(tables.member.organizationId);
        for (const membership of memberships)
          await db.execute(
            sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${membership.workspace}::text,0))`,
          );
        await db.execute(sql`SELECT collab_lock_user_pages(${value.user.id}::uuid)`);
        // A policy activation or in-flight page write may have held us past freshness.
        await fresh(value);
        const all = await factors(value.user.id);
        const remaining =
          path === '/two-factor/disable'
            ? all.keys.length
            : all.keys.filter((key) => key.id !== ctx.body?.id).length +
              (all.totp?.verified ? 1 : 0);
        const required = await db.execute(
          sql`SELECT 1 FROM workspace_members m JOIN workspace_policies p ON p.workspace_id=m.workspace_id WHERE m.user_id=${value.user.id}::uuid AND p.require_strong_auth LIMIT 1`,
        );
        if (!remaining && required.rows.length) throw denied('LAST_FACTOR_REQUIRED');
      }
      if (path === '/two-factor/verify-totp') {
        const id = ctx.headers?.get('x-memoria-challenge');
        if (!id || !z.uuid().safeParse(id).success) throw denied('CHALLENGE_REQUIRED');
        const all = await factors(value.user.id);
        if (!all.totp) throw denied('TOTP_NOT_ENABLED');
        flow.enrolling = !all.totp.verified;
        if (!flow.enrolling) await factorReady(value.user.id, all.totp.id);
        if (flow.recovering && !flow.enrolling) throw denied('RECOVERY_FINISH_REQUIRED');
        if (flow.enrolling) await enrollment(value);
        flow.firstFactor = !all.active;
        flow.factorId = all.totp.id;
        const attempt = await db.execute(sql`UPDATE auth_factor_challenges SET attempts=attempts+1
          WHERE id=${id}::uuid AND session_id=${value.session.id}::uuid AND user_id=${value.user.id}::uuid
          AND purpose=${flow.enrolling ? 'totp-enroll' : 'totp-auth'} AND attempts<5 AND consumed_at IS NULL
          AND expires_at>clock_timestamp() RETURNING id`);
        if (!attempt.rows.length) throw denied('CHALLENGE_EXHAUSTED_OR_EXPIRED');
        flow.challenge = id;
        const code: unknown = ctx.body?.code;
        if (typeof code !== 'string' || !/^\d{6}$/.test(code)) throw denied('INVALID_CODE');
        const otp = createOTP(
          await symmetricDecrypt({ key: ctx.context.secretConfig, data: all.totp.secret }),
          { digits: 6, period: 30 },
        );
        const current = Math.floor(Date.now() / 30000);
        for (const step of [current - 1, current, current + 1])
          if (timingSafeEqual(Buffer.from(await otp.hotp(step)), Buffer.from(code)))
            flow.step = step;
        const [security] = await db
          .select()
          .from(tables.accountSecurity)
          .where(eq(tables.accountSecurity.userId, value.user.id));
        if (flow.step !== undefined && flow.step <= security!.lastTotpStep)
          throw denied('TOTP_ALREADY_USED');
      }
    }),
    after: createAuthMiddleware(async (ctx) => {
      const path = ctx.path ?? '';
      if (ctx.context.returned instanceof APIError) return;
      if (path === '/sign-in/email') {
        const value = ctx.context.newSession;
        if (!value) return;
        if (!flow) {
          if ((await factors(value.user.id)).active) {
            await db.delete(tables.session).where(eq(tables.session.id, value.session.id));
            throw denied('SECURITY_TRANSACTION_REQUIRED');
          }
          return;
        }
        await lock(value.user.id);
        await db.insert(tables.sessionSecurity).values({
          sessionId: value.session.id,
          passwordVerifiedAt: new Date(),
          sharedComputer: flow.sharedComputer === true,
        });
        const requiresStrongAuth =
          (await factors(value.user.id)).active ||
          (
            await db
              .select()
              .from(tables.accountSecurity)
              .where(eq(tables.accountSecurity.userId, value.user.id))
          )[0]?.recoveryRequired === true;
        if (!requiresStrongAuth && value.user.emailVerified)
          await resetAccountAttempts(db, secret, value.user.id);
        return ctx.json({ ...(ctx.context.returned as object), requiresStrongAuth });
      }
      if (!flow) return;
      if (path === '/verify-password' && flow.initial) {
        await db
          .insert(tables.sessionSecurity)
          .values({ sessionId: flow.initial.session.id, passwordVerifiedAt: new Date() })
          .onConflictDoUpdate({
            target: tables.sessionSecurity.sessionId,
            set: { passwordVerifiedAt: new Date() },
          });
      }
      if (path === '/passkey/generate-authenticate-options')
        return ctx.json({ ...(ctx.context.returned as object), userVerification: 'required' });
      if (path === '/two-factor/enable') {
        // Never expose the unrelated native backup-code set.
        return ctx.json({ totpURI: (ctx.context.returned as { totpURI?: string }).totpURI });
      }
      if (
        path === '/passkey/verify-registration' ||
        (path === '/two-factor/verify-totp' && flow.enrolling)
      ) {
        const value = ctx.context.newSession ?? flow.initial;
        if (!value) throw denied('SESSION_REQUIRED');
        if (flow.initialSettings && flow.initialSettings.sessionId !== value.session.id) {
          await db
            .insert(tables.sessionSecurity)
            .values({ ...flow.initialSettings, sessionId: value.session.id })
            .onConflictDoNothing();
        }
        if (flow.recovering) {
          if (!flow.recoveryExpiry) throw new Error('RECOVERY_EXPIRY_MISSING');
          await db
            .update(tables.session)
            .set({ expiresAt: flow.recoveryExpiry })
            .where(eq(tables.session.id, value.session.id));
          await db
            .insert(tables.sessionSecurity)
            .values({ sessionId: value.session.id, sharedComputer: true })
            .onConflictDoNothing();
        }
        if (flow.step !== undefined)
          await db
            .update(tables.accountSecurity)
            .set({ lastTotpStep: flow.step })
            .where(eq(tables.accountSecurity.userId, value.user.id));
        await changed(value.user.id, value.session.id);
        if (flow.recovering) {
          const all = await factors(value.user.id);
          // TOTP uses its exact verified ID; a passkey response identifies the new credential.
          const credential = ctx.body?.response?.id;
          const added =
            path === '/passkey/verify-registration'
              ? all.keys.find((key) => key.credentialID === credential)?.id
              : flow.factorId;
          if (!added) throw new Error('RECOVERY_FACTOR_MISSING');
          await db
            .update(tables.accountSecurity)
            .set({
              recoveryPendingFactors: sql`array_append(${tables.accountSecurity.recoveryPendingFactors},${added}::uuid)`,
            })
            .where(eq(tables.accountSecurity.userId, value.user.id));
          await db
            .update(tables.sessionSecurity)
            .set({ recoveryFactorId: added })
            .where(eq(tables.sessionSecurity.sessionId, value.session.id));
        }
        return ctx.json({
          status: true,
          enrollmentComplete: true,
          requiresStrongAuth: true,
          ...(flow.firstFactor && !flow.recovering
            ? { recoveryCodes: await codes(value.user.id) }
            : {}),
        });
      }
      if (path === '/two-factor/verify-totp') {
        const value = flow.initial;
        if (!value || flow.step === undefined || !flow.factorId) throw denied('PROOF_MISSING');
        await db
          .update(tables.accountSecurity)
          .set({ lastTotpStep: flow.step })
          .where(eq(tables.accountSecurity.userId, value.user.id));
        const created = await ctx.context.internalAdapter.createSession(value.user.id);
        if (!created) throw denied('SESSION_CREATION_FAILED');
        flow.proof = { userId: value.user.id, factorId: flow.factorId, method: 'totp' };
        await recordProof(created.id, flow.proof);
        await setSessionCookie(ctx, { session: created, user: value.user });
        return ctx.json({ status: true });
      }
      if (path === '/passkey/verify-authentication') {
        const created = ctx.context.newSession;
        if (!created || !flow.proof) throw denied('PROOF_MISSING');
        await recordProof(created.session.id, flow.proof);
      }
      if ((path === '/two-factor/disable' || path === '/passkey/delete-passkey') && flow.initial) {
        await changed(flow.initial.user.id);
        return ctx.json({ status: true, signInRequired: true });
      }
    }),
  };
  const plugin = {
    id: 'memoria-security',
    endpoints: {
      ...recoveryEndpoints(db, secret, flow, identity, codes),
      cachePolicy: createAuthEndpoint(
        '/security/cache-policy',
        { method: 'GET', use: [sessionMiddleware] },
        async (ctx) => {
          const value = await identity(ctx);
          const [settings] = await db
            .select()
            .from(tables.sessionSecurity)
            .where(eq(tables.sessionSecurity.sessionId, value.session.id));
          const policies = await db.execute<{
            workspace: string;
            version: number;
            allowed: boolean;
          }>(sql`
            SELECT m.workspace_id AS workspace,coalesce(p.security_version,1) AS version,
              coalesce(p.allow_persistent_cache,true) AS allowed
            FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
            LEFT JOIN workspace_policies p ON p.workspace_id=m.workspace_id
            WHERE m.user_id=${value.user.id}::uuid AND m.role IN ('owner','member')`);
          return ctx.json({
            user: value.user.id,
            session: value.session.id,
            sharedComputer: settings?.sharedComputer === true || flow?.recovering === true,
            workspaces: policies.rows,
          });
        },
      ),
      securityStatus: createAuthEndpoint(
        '/security/status',
        { method: 'GET', use: [sessionMiddleware] },
        async (ctx) => {
          const value = await identity(ctx),
            all = await factors(value.user.id);
          const assurance = await readAssurance(db, value.session.id);
          const [state] = await db
            .select()
            .from(tables.accountSecurity)
            .where(eq(tables.accountSecurity.userId, value.user.id));
          const [settings] = await db
            .select()
            .from(tables.sessionSecurity)
            .where(eq(tables.sessionSecurity.sessionId, value.session.id));
          return ctx.json({
            ...assurance,
            userId: value.user.id,
            sessionId: value.session.id,
            sharedComputer: settings?.sharedComputer === true,
            totpEnabled: all.totp?.verified === true,
            totpPending: all.totp?.verified === false,
            passkeys: all.keys.map(({ id, name, createdAt }) => ({ id, name, createdAt })),
            requiresStrongAuth:
              (all.active || state?.recoveryRequired === true) && !assurance.strong,
            recovery: flow?.recovering === true,
            recoveryRequired: state?.recoveryRequired === true,
            recoveryFactorReady: !!settings?.recoveryFactorId,
            recoveryCodesRemaining: (
              await db
                .select()
                .from(tables.recoveryCodes)
                .where(
                  and(
                    eq(tables.recoveryCodes.userId, value.user.id),
                    sql`${tables.recoveryCodes.consumedAt} IS NULL`,
                  ),
                )
            ).length,
          });
        },
      ),
      factorChallenge: createAuthEndpoint(
        '/security/challenge',
        { method: 'POST', use: [sessionMiddleware], body: z.object({}).strict() },
        async (ctx) => {
          const value = await identity(ctx),
            all = await factors(value.user.id);
          if (!all.totp) throw denied('TOTP_NOT_ENABLED');
          await db
            .delete(tables.factorChallenges)
            .where(
              and(
                eq(tables.factorChallenges.userId, value.user.id),
                sql`${tables.factorChallenges.expiresAt}<=clock_timestamp()`,
              ),
            );
          const purpose = all.totp.verified ? 'totp-auth' : 'totp-enroll';
          const [existing] = await db
            .select()
            .from(tables.factorChallenges)
            .where(
              and(
                eq(tables.factorChallenges.sessionId, value.session.id),
                eq(tables.factorChallenges.purpose, purpose),
                sql`${tables.factorChallenges.expiresAt}>clock_timestamp()`,
                sql`${tables.factorChallenges.consumedAt} IS NULL`,
              ),
            );
          if (existing)
            return ctx.json({
              id: existing.id,
              expiresAt: existing.expiresAt,
              attemptsRemaining: 5 - existing.attempts,
            });
          const [created] = await db
            .insert(tables.factorChallenges)
            .values({
              sessionId: value.session.id,
              userId: value.user.id,
              purpose,
              expiresAt: new Date(Date.now() + 300000),
            })
            .returning();
          return ctx.json({ id: created!.id, expiresAt: created!.expiresAt, attemptsRemaining: 5 });
        },
      ),
      regenerateRecoveryCodes: createAuthEndpoint(
        '/security/recovery-codes',
        { method: 'POST', use: [sessionMiddleware], body: z.object({}).strict() },
        async (ctx) => {
          const value = await identity(ctx);
          await fresh(value);
          return ctx.json({ recoveryCodes: await codes(value.user.id) });
        },
      ),
    },
  };
  return {
    hooks,
    totpPlugin,
    passkeyPlugin,
    plugin,
    async passwordReset(userId: string) {
      await lock(userId);
      const [state] = await db
        .select()
        .from(tables.accountSecurity)
        .where(eq(tables.accountSecurity.userId, userId));
      await revokeForRecovery(db, userId, state?.recoveryRequired === true);
      await audit(userId, 'password_reset');
      await securityNotice(
        db,
        secret,
        userId,
        'Votre mot de passe a été réinitialisé. Toutes vos sessions ont été fermées ; vos facteurs restent inchangés. Si vous n’avez pas demandé ce changement, contactez votre exploitant.',
      );
    },
  };
}
