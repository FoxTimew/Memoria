import { eq, sql } from 'drizzle-orm';
import { authMailJobs } from '@memoria/db';
import type { Database } from '@memoria/db';
import { createAuth } from './create-auth.ts';
import { readMailPayload } from './recovery-core.ts';

/** One durable job; SMTP is never awaited by a public request. Delivery is at least once. */
export async function processAuthMail(
  database: Database,
  options: {
    origin: string;
    secret: string;
    send(email: string, subject: string, text: string): Promise<void>;
    report?: (event: { action: string; jobId: string; attempt: number }) => void;
  },
) {
  return database.transaction(async (tx) => {
    await tx.delete(authMailJobs).where(sql`${authMailJobs.expiresAt}<=clock_timestamp()`);
    const jobs = await tx
      .select()
      .from(authMailJobs)
      .where(sql`${authMailJobs.availableAt}<=clock_timestamp()`)
      .orderBy(authMailJobs.availableAt, authMailJobs.id)
      .limit(1)
      .for('update', { skipLocked: true });
    const job = jobs[0];
    if (!job) return false;
    try {
      await tx.transaction(async (nested) => {
        const payload = await readMailPayload(options.secret, job.payload);
        if (job.kind === 'password-request') {
          const auth = createAuth(nested, { ...options, sendVerificationEmail: async () => {} });
          await auth.api.requestPasswordReset({ body: { email: payload.email } });
        } else {
          if (!payload.subject || !payload.text) throw new Error('INVALID_MAIL');
          await options.send(payload.email, payload.subject, payload.text);
        }
      });
      await tx.delete(authMailJobs).where(eq(authMailJobs.id, job.id));
    } catch {
      const attempt = job.attempts + 1;
      if (attempt >= 6) await tx.delete(authMailJobs).where(eq(authMailJobs.id, job.id));
      else
        await tx
          .update(authMailJobs)
          .set({
            attempts: attempt,
            availableAt: new Date(Date.now() + Math.min(300000, 1000 * 2 ** attempt)),
          })
          .where(eq(authMailJobs.id, job.id));
      options.report?.({
        action: attempt >= 6 ? 'auth_mail_abandoned' : 'auth_mail_retry',
        jobId: job.id,
        attempt,
      });
    }
    return true;
  });
}
