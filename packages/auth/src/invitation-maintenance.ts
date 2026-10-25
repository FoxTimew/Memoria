import { sql } from 'drizzle-orm';
import type { Database } from '@memoria/db';
import { invitationPolicy } from './invitation-policy.ts';
/** Terminal time is immutable; failed/retried delivery never extends retention. */
export async function purgeInvitations(db: Database) {
  const limits = invitationPolicy();
  await db.transaction(async (tx) => {
    // Delete jobs before their invitation row, matching the mail worker's lock order.
    await tx.execute(
      sql`DELETE FROM auth_mail_jobs WHERE invitation_id IS NOT NULL AND expires_at<=clock_timestamp()`,
    );
    await tx.execute(
      sql`UPDATE workspace_invitations SET status='expired' WHERE status='pending' AND expires_at<=clock_timestamp()`,
    );
    await tx.execute(
      sql`UPDATE workspace_invitations i SET delivery_status='expired' WHERE delivery_status IN ('queued','retrying') AND NOT EXISTS(SELECT 1 FROM auth_mail_jobs j WHERE j.invitation_id=i.id)`,
    );
    await tx.execute(
      sql`DELETE FROM workspace_invitations WHERE closed_at<clock_timestamp()-${limits.INVITATION_RETENTION_DAYS}*interval '1 day'`,
    );
  });
}
