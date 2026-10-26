import { sql } from 'drizzle-orm';
import type { WriteTransaction } from '@memoria/db';
import { readAssurance } from './assurance.ts';

export interface SessionIdentity {
  id: string;
  userId: string;
}
export class SecurityPolicyError extends Error {
  constructor(
    readonly code: string,
    readonly status: number = 403,
  ) {
    super(code);
  }
}
/** Acquire before workspace/page locks. Prevent logout racing a relational transaction. */
export async function lockSession(tx: WriteTransaction, session: SessionIdentity) {
  const result = await tx.execute(sql`SELECT id FROM auth_sessions WHERE id=${session.id}::uuid
    AND user_id=${session.userId}::uuid AND expires_at>clock_timestamp() FOR SHARE`);
  if (!result.rows.length) throw new SecurityPolicyError('SESSION_REVOKED', 401);
}
export type SensitiveAction =
  | 'workspace.policy'
  | 'workspace.cache'
  | 'workspace.access'
  | 'member.role'
  | 'api_key.create'
  | 'webhook.create';
/** Caller runs the effect in this transaction, immediately after this check. No reusable permit. */
export async function requireSensitiveAction(
  tx: WriteTransaction,
  session: SessionIdentity,
  workspace: string,
  action: SensitiveAction,
) {
  if (
    ![
      'workspace.policy',
      'workspace.cache',
      'workspace.access',
      'member.role',
      'api_key.create',
      'webhook.create',
    ].includes(action)
  )
    throw new SecurityPolicyError('UNKNOWN_SENSITIVE_ACTION');
  await tx.execute(
    sql`INSERT INTO account_security(user_id) VALUES(${session.userId}::uuid) ON CONFLICT DO NOTHING`,
  );
  await tx.execute(
    sql`SELECT user_id FROM account_security WHERE user_id=${session.userId}::uuid FOR UPDATE`,
  );
  await lockSession(tx, session);
  await tx.execute(sql`SELECT pg_advisory_xact_lock(hashtextextended(${workspace}::text,0))`);
  // Wait for in-flight collaborative commits before changing policy/roles. The journal itself
  // still takes only its page lock, never the workspace lock.
  if (['workspace.policy', 'workspace.cache', 'workspace.access', 'member.role'].includes(action))
    await tx.execute(sql`SELECT database_lock_workspace(${workspace}::uuid)`);
  const result = await tx.execute<{
    id: string;
    role: string;
    actor: string;
  }>(sql`SELECT m.id,m.role,a.id AS actor
    FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
    JOIN LATERAL(SELECT id FROM actors WHERE workspace_id=m.workspace_id AND user_id=m.user_id AND kind='user' ORDER BY created_at,id LIMIT 1) a ON true
    WHERE m.user_id=${session.userId}::uuid AND m.workspace_id=${workspace}::uuid`);
  const member = result.rows[0];
  if (!member || !['owner', 'admin', 'member'].includes(member.role))
    throw new SecurityPolicyError('WORKSPACE_INACCESSIBLE', 404);
  if (
    action !== 'api_key.create' &&
    member.role !== 'owner' &&
    !(
      member.role === 'admin' &&
      ['workspace.access', 'workspace.cache', 'member.role'].includes(action)
    )
  )
    throw new SecurityPolicyError('OWNER_REQUIRED');
  const assurance = await readAssurance(tx, session.id);
  if (!assurance.recent) throw new SecurityPolicyError('RECENT_STRONG_AUTH_REQUIRED');
  return member;
}
