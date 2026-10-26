import { eq, sql } from 'drizzle-orm';
import { authMailJobs, invitation } from '@memoria/db';
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
    if (job.kind === 'invitation') {
      const current = await tx.execute(
        sql`SELECT id FROM workspace_invitations WHERE id=${job.invitationId}::uuid AND status='pending' AND expires_at>clock_timestamp()`,
      );
      if (!current.rows.length) {
        await tx.delete(authMailJobs).where(eq(authMailJobs.id, job.id));
        return true;
      }
    }
    try {
      await tx.transaction(async (nested) => {
        const payload = await readMailPayload(options.secret, job.payload);
        if (job.kind === 'password-request' || job.kind === 'verification-request') {
          const auth = createAuth(nested, { ...options, mailBudgetGranted: true });
          if (job.kind === 'password-request')
            await auth.api.requestPasswordReset({ body: { email: payload.email } });
          else
            await auth.api.sendVerificationEmail({
              body: { email: payload.email, callbackURL: '/connexion?verified=1' },
            });
        } else {
          if (!payload.subject || !payload.text) throw new Error('INVALID_MAIL');
          await options.send(payload.email, payload.subject, payload.text);
        }
      });
      await tx.delete(authMailJobs).where(eq(authMailJobs.id, job.id));
      if (job.invitationId)
        await tx
          .update(invitation)
          .set({ deliveryStatus: 'sent' })
          .where(eq(invitation.id, job.invitationId));
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
      if (job.invitationId)
        await tx
          .update(invitation)
          .set({ deliveryStatus: attempt >= 6 ? 'failed' : 'retrying' })
          .where(eq(invitation.id, job.invitationId));
      options.report?.({
        action: attempt >= 6 ? 'auth_mail_abandoned' : 'auth_mail_retry',
        jobId: job.id,
        attempt,
      });
    }
    return true;
  });
}
