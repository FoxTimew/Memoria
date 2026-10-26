import { z } from 'zod';
/** Shared by the API, Better Auth and the mail worker; invalid deployment values fail closed. */
export function invitationPolicy(env: NodeJS.ProcessEnv = process.env) {
  const value = z
    .object({
      INVITATION_VALIDITY_DAYS: z.coerce.number().int().min(1).max(30).default(7),
      INVITATION_RETENTION_DAYS: z.coerce.number().int().positive().default(30),
      INVITATION_MAIL_TTL_HOURS: z.coerce.number().int().min(1).max(24).default(24),
      WORKSPACE_MAX_MEMBERS: z.coerce.number().int().positive().default(100),
      WORKSPACE_MAX_PENDING_INVITATIONS: z.coerce.number().int().positive().default(500),
      GUEST_MAX_SHARED_ROOTS: z.coerce.number().int().positive().default(100),
      WORKSPACE_MAX_SHARES: z.coerce.number().int().positive().default(5000),
    })
    .safeParse(env);
  if (!value.success) throw new Error('Invalid invitation limits configuration');
  return value.data;
}
