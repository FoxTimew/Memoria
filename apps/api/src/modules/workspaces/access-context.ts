import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { sql } from 'drizzle-orm';
import { lockSession, readAssurance } from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import type { WriteTransaction } from '@memoria/db';
import type { z } from 'zod';
import { uuid } from '../pages/content-access.ts';
export function accessInput<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException({ code: 'INVALID_ACCESS_REQUEST' });
  return result.data;
}
export async function lockAccessIdentity(tx: WriteTransaction, session: SessionIdentity) {
  await tx.execute(
    sql`INSERT INTO account_security(user_id) VALUES(${session.userId}::uuid) ON CONFLICT DO NOTHING`,
  );
  await tx.execute(
    sql`SELECT user_id FROM account_security WHERE user_id=${session.userId}::uuid FOR UPDATE`,
  );
  await lockSession(tx, session);
  if (!(await readAssurance(tx, session.id)).content)
    throw new ForbiddenException({ code: 'STRONG_AUTH_REQUIRED' });
  const user = (
    await tx.execute<{ email: string }>(
      sql`SELECT email FROM auth_users WHERE id=${session.userId}::uuid AND email_verified=true`,
    )
  ).rows[0];
  if (!user) throw new ForbiddenException({ code: 'EMAIL_NOT_VERIFIED' });
  return user;
}
export async function readManager(
  tx: WriteTransaction,
  session: SessionIdentity,
  workspace: string,
) {
  uuid(workspace);
  await lockSession(tx, session);
  await tx.execute(
    sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${workspace}::text,0))`,
  );
  const row = (
    await tx.execute<{ id: string; role: string }>(sql`SELECT m.id,m.role FROM workspace_members m
    WHERE m.workspace_id=${workspace}::uuid AND m.user_id=${session.userId}::uuid AND m.role IN ('owner','admin')
    AND auth_session_can_access_workspace(${session.id}::uuid,${workspace}::uuid)`)
  ).rows[0];
  if (!row) throw new NotFoundException({ code: 'WORKSPACE_INACCESSIBLE' });
  return row;
}
export function mayManageRole(principal: { role: string }, role: string) {
  if (principal.role !== 'owner' && !['member', 'guest'].includes(role))
    throw new ForbiddenException({ code: 'OWNER_REQUIRED' });
}
