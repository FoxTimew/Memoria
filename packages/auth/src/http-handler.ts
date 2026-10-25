import type { Database } from '@memoria/db';
import { createAuth } from './create-auth.ts';
import type { AuthOptions } from './create-auth.ts';
import { z } from 'zod';
import {
  accountKey,
  admitAttempt,
  checkIp,
  finishAttempt,
  Throttled,
  waitAttempt,
} from './throttle.ts';
import type { Attempt } from './throttle.ts';
import { queueAuthMail } from './recovery-core.ts';
import { sql } from 'drizzle-orm';

class FailedAuthTransaction extends Error {}

/** No response headers/cookie leave the server before the security transaction commits. */
export async function handleAuthRequest(
  database: Database,
  options: AuthOptions,
  request: Request,
): Promise<Response> {
  let attempt: Attempt | undefined;
  let failed = false;
  try {
    const path = new URL(request.url).pathname.slice('/api/auth'.length);
    await checkIp(
      database,
      options.secret,
      path,
      request.headers.get('x-memoria-client-ip') ?? 'unknown',
    );
    let body: Record<string, unknown> = {};
    if (request.body) {
      const reader = request.body.getReader();
      const chunks: Uint8Array[] = [];
      let length = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        length += next.value.length;
        if (length > 65536) {
          await reader.cancel();
          return Response.json({ code: 'BODY_TOO_LARGE' }, { status: 413 });
        }
        chunks.push(next.value);
      }
      const text = Buffer.concat(chunks).toString('utf8');
      try {
        body = JSON.parse(text) as Record<string, unknown>;
      } catch {
        return Response.json({ code: 'INVALID_BODY' }, { status: 400 });
      }
      if (!body || typeof body !== 'object' || Array.isArray(body))
        return Response.json({ code: 'INVALID_BODY' }, { status: 400 });
      request = new Request(request.url, {
        method: request.method,
        headers: request.headers,
        body: text,
        signal: request.signal,
      });
    }
    const email = z.email().max(254).safeParse(body.email);
    const recoveryRoute = ['/security/recover', '/security/operator-recover'].includes(path);
    const recoveryChallenge = path === '/security/recovery-challenge';
    const passwordRoute = path === '/sign-in/email' || recoveryRoute;
    // Reject before delegating: a looser native email parser must not bypass account admission.
    if (passwordRoute && !email.success)
      return Response.json({ code: 'INVALID_EMAIL' }, { status: 400 });
    const sessionRoute = [
      '/verify-password',
      '/two-factor/enable',
      '/two-factor/disable',
      '/two-factor/verify-totp',
      '/security/challenge',
    ].includes(path);
    let key: string | undefined;
    if ((passwordRoute || recoveryChallenge) && email.success)
      key = accountKey(options.secret, email.data);
    if (sessionRoute) {
      const session = await createAuth(database, options).api.getSession({
        headers: request.headers,
        query: { disableRefresh: true, disableCookieCache: true },
      });
      if (session) key = accountKey(options.secret, session.user.email);
    }
    if (path === '/sign-up/email' || path === '/reset-password')
      key = accountKey(
        options.secret,
        `cost:${path}:${email.success ? email.data : String(body.token ?? '')}`,
      );
    if (key) {
      const lane = path.includes('recover') ? 'recovery' : sessionRoute ? 'factor' : 'password';
      attempt = await admitAttempt(database, key, lane);
      await waitAttempt(database, attempt, request.signal);
    }
    if (recoveryChallenge && request.method === 'POST') {
      if (
        !key ||
        !z
          .strictObject({ email: z.email().max(254), purpose: z.enum(['code', 'operator']) })
          .safeParse(body).success
      )
        return Response.json({ code: 'INVALID_BODY' }, { status: 400 });
      const row = (
        await database.execute(
          sql`INSERT INTO auth_recovery_challenges(account_key,purpose,expires_at) VALUES(${key},${String(body.purpose)},clock_timestamp()+interval '5 minutes') RETURNING id,expires_at`,
        )
      ).rows[0]!;
      return Response.json({ id: row.id, expiresAt: row.expires_at });
    }
    if (recoveryRoute) {
      const id = request.headers.get('x-memoria-recovery-challenge');
      if (!key || !z.uuid().safeParse(id).success)
        return Response.json({ code: 'CHALLENGE_REQUIRED' }, { status: 403 });
      const used =
        await database.execute(sql`UPDATE auth_recovery_challenges SET attempts=attempts+1 WHERE id=${id}::uuid AND account_key=${key}
        AND purpose=${path === '/security/recover' ? 'code' : 'operator'} AND attempts<5 AND expires_at>clock_timestamp() RETURNING id`);
      if (!used.rows.length)
        return Response.json({ code: 'CHALLENGE_EXHAUSTED_OR_EXPIRED' }, { status: 403 });
    }
    if (path === '/send-verification-email' && request.method === 'POST') {
      if (!email.success) return Response.json({ code: 'INVALID_EMAIL' }, { status: 400 });
      await database.transaction((tx) =>
        queueAuthMail(tx, options.secret, 'verification-request', {
          email: email.data.toLowerCase(),
        }),
      );
      return Response.json({ status: true });
    }
    const response = await database.transaction(async (transaction) => {
      const auth = createAuth(transaction, {
        ...options,
        securityFlow: {
          sharedComputer: request.headers.get('x-memoria-shared-computer') === 'true',
        },
      });
      const response = await auth.handler(request);
      // Library error handlers return HTTP responses; force SQL rollback on an internal failure.
      if (response.status >= 500) throw new FailedAuthTransaction();
      return response;
    });
    failed =
      !!attempt &&
      (passwordRoute || sessionRoute) &&
      response.status >= 400 &&
      response.status < 500;
    return response;
  } catch (error) {
    if (error instanceof Throttled)
      return Response.json(
        { code: error.code, message: 'Patientez puis réessayez.' },
        {
          status: 429,
          headers: {
            'Retry-After': String(error.retryAfter),
            'X-Retry-After': String(error.retryAfter),
          },
        },
      );
    if (request.signal.aborted) return new Response(null, { status: 499 });
    return Response.json(
      { code: 'AUTH_TRANSACTION_FAILED', message: 'Réessayez la connexion.' },
      { status: 500 },
    );
  } finally {
    if (attempt) await finishAttempt(database, attempt, failed);
  }
}
