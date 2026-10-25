import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { eq, sql } from 'drizzle-orm';
import { member, workspacePolicies, auditLogs } from '@memoria/db';
import { requireSensitiveAction, readAssurance } from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import { workspaceSecurityUpdateSchema } from '@memoria/contracts';
import * as database from '../../database.module.ts';
import { uuid } from '../pages/content-access.ts';

@Injectable()
export class WorkspaceSecurityService {
  constructor(private readonly database: database.DatabaseService) {}
  async read(session: SessionIdentity, workspace: string) {
    uuid(workspace);
    const result = await this.database.db.execute<{
      role: 'owner' | 'admin' | 'member';
      require_strong_auth: boolean;
      grace_days: number;
      security_version: number;
      strong_auth_enabled_at: Date | null;
      mfa_deadline: Date | null;
      allowed: boolean;
      allow_persistent_cache: boolean;
    }>(sql`
      SELECT m.role,coalesce(p.require_strong_auth,false) AS require_strong_auth,coalesce(p.grace_days,7) AS grace_days,
      coalesce(p.security_version,1) AS security_version,coalesce(p.allow_persistent_cache,true) AS allow_persistent_cache,p.strong_auth_enabled_at,m.mfa_deadline,
      auth_session_can_access_workspace(${session.id}::uuid,${workspace}::uuid) AS allowed
      FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN workspace_policies p ON p.workspace_id=w.id
      WHERE m.workspace_id=${workspace}::uuid AND m.user_id=${session.userId}::uuid AND m.role IN ('owner','admin','member')`);
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Espace inaccessible.');
    return {
      role: row.role,
      allowPersistentCache: row.allow_persistent_cache,
      requireStrongAuth: row.require_strong_auth,
      graceDays: row.grace_days,
      version: row.security_version,
      enabledAt: row.strong_auth_enabled_at
        ? new Date(row.strong_auth_enabled_at).toISOString()
        : null,
      deadline: row.mfa_deadline ? new Date(row.mfa_deadline).toISOString() : null,
      contentAllowed: row.allowed,
      recentStrong: (await readAssurance(this.database.db, session.id)).recent,
    };
  }
  async update(session: SessionIdentity, workspace: string, input: unknown) {
    uuid(workspace);
    const parsed = workspaceSecurityUpdateSchema.safeParse(input);
    if (!parsed.success)
      throw new BadRequestException('Politique invalide (grâce de 0 à 30 jours).');
    const data = parsed.data;
    await this.database.db.transaction(async (tx) => {
      const principal = await requireSensitiveAction(
        tx,
        session,
        workspace,
        'requireStrongAuth' in data ? 'workspace.policy' : 'workspace.cache',
      );
      await tx
        .insert(workspacePolicies)
        .values({ workspaceId: workspace, createdBy: principal.actor, updatedBy: principal.actor })
        .onConflictDoNothing();
      const [previous] = await tx
        .select()
        .from(workspacePolicies)
        .where(eq(workspacePolicies.workspaceId, workspace));
      if (previous!.securityVersion !== data.expectedVersion)
        throw new ConflictException({ code: 'SECURITY_VERSION_CONFLICT' });
      const requireStrongAuth =
        'requireStrongAuth' in data ? data.requireStrongAuth : previous!.requireStrongAuth;
      const graceDays = 'graceDays' in data ? data.graceDays : previous!.graceDays;
      if (requireStrongAuth && !previous!.requireStrongAuth) {
        // An explicit disable/re-enable cannot silently postpone an older deadline either.
        await tx
          .update(member)
          .set({
            mfaDeadline: sql`least(coalesce(${member.mfaDeadline},clock_timestamp()+${graceDays}*interval '1 day'),clock_timestamp()+${graceDays}*interval '1 day')`,
          })
          .where(eq(member.organizationId, workspace));
      }
      await tx
        .update(workspacePolicies)
        .set({
          requireStrongAuth,
          allowPersistentCache: data.allowPersistentCache ?? previous!.allowPersistentCache,
          graceDays,
          strongAuthEnabledAt:
            requireStrongAuth && !previous!.requireStrongAuth
              ? new Date()
              : previous!.strongAuthEnabledAt,
          securityVersion: sql`${workspacePolicies.securityVersion}+1`,
          updatedAt: new Date(),
          updatedBy: principal.actor,
        })
        .where(eq(workspacePolicies.workspaceId, workspace));
      await tx.insert(auditLogs).values({
        workspaceId: workspace,
        actorId: principal.actor,
        action: 'workspace.security.changed',
        resourceType: 'workspace',
        resourceId: workspace,
        metadata: {
          requireStrongAuth,
          graceDays,
          version: data.expectedVersion + 1,
          allowPersistentCache: data.allowPersistentCache ?? previous!.allowPersistentCache,
        },
      });
    });
    return this.read(session, workspace);
  }
}
