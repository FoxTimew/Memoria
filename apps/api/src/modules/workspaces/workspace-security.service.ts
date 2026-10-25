import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { member, workspacePolicies, auditLogs } from '@memoria/db';
import { lockSession, requireSensitiveAction, readAssurance } from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import { workspaceSecurityUpdateSchema, workspaceRoleUpdateSchema } from '@memoria/contracts';
import * as database from '../../database.module.ts';
import { uuid } from '../pages/content-access.ts';

@Injectable()
export class WorkspaceSecurityService {
  constructor(private readonly database: database.DatabaseService) {}
  async read(session: SessionIdentity, workspace: string) {
    uuid(workspace);
    const result = await this.database.db.execute<{
      role: 'owner' | 'member';
      require_strong_auth: boolean;
      grace_days: number;
      security_version: number;
      strong_auth_enabled_at: Date | null;
      mfa_deadline: Date | null;
      allowed: boolean;
    }>(sql`
      SELECT m.role,coalesce(p.require_strong_auth,false) AS require_strong_auth,coalesce(p.grace_days,7) AS grace_days,
      coalesce(p.security_version,1) AS security_version,p.strong_auth_enabled_at,m.mfa_deadline,
      auth_session_can_access_workspace(${session.id}::uuid,${workspace}::uuid) AS allowed
      FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
      LEFT JOIN workspace_policies p ON p.workspace_id=w.id
      WHERE m.workspace_id=${workspace}::uuid AND m.user_id=${session.userId}::uuid AND m.role IN ('owner','member')`);
    const row = result.rows[0];
    if (!row) throw new NotFoundException('Espace inaccessible.');
    return {
      role: row.role,
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
      const principal = await requireSensitiveAction(tx, session, workspace, 'workspace.policy');
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
      if (data.requireStrongAuth && !previous!.requireStrongAuth) {
        // An explicit disable/re-enable cannot silently postpone an older deadline either.
        await tx
          .update(member)
          .set({
            mfaDeadline: sql`least(coalesce(${member.mfaDeadline},clock_timestamp()+${data.graceDays}*interval '1 day'),clock_timestamp()+${data.graceDays}*interval '1 day')`,
          })
          .where(eq(member.organizationId, workspace));
      }
      await tx
        .update(workspacePolicies)
        .set({
          requireStrongAuth: data.requireStrongAuth,
          graceDays: data.graceDays,
          strongAuthEnabledAt:
            data.requireStrongAuth && !previous!.requireStrongAuth
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
          requireStrongAuth: data.requireStrongAuth,
          graceDays: data.graceDays,
          version: data.expectedVersion + 1,
        },
      });
    });
    return this.read(session, workspace);
  }
  async members(session: SessionIdentity, workspace: string) {
    uuid(workspace);
    return this.database.db.transaction(async (tx) => {
      await lockSession(tx, session);
      await tx.execute(
        sql`SELECT pg_advisory_xact_lock_shared(hashtextextended(${workspace}::text,0))`,
      );
      const allowed = await tx.execute(
        sql`SELECT 1 FROM workspace_members WHERE workspace_id=${workspace}::uuid AND user_id=${session.userId}::uuid AND role='owner' AND auth_session_can_access_workspace(${session.id}::uuid,${workspace}::uuid)`,
      );
      if (!allowed.rows.length) throw new ForbiddenException({ code: 'OWNER_REQUIRED' });
      const result = await tx.execute<{
        id: string;
        name: string;
        role: string;
        mfa_deadline: Date | null;
      }>(
        sql`SELECT m.id,u.name,m.role,m.mfa_deadline FROM workspace_members m JOIN auth_users u ON u.id=m.user_id WHERE m.workspace_id=${workspace}::uuid ORDER BY m.created_at,m.id`,
      );
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        deadline: row.mfa_deadline ? new Date(row.mfa_deadline).toISOString() : null,
      }));
    });
  }
  async role(session: SessionIdentity, workspace: string, target: string, input: unknown) {
    uuid(workspace);
    uuid(target);
    const parsed = workspaceRoleUpdateSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Rôle invalide.');
    const data = parsed.data;
    await this.database.db.transaction(async (tx) => {
      const principal = await requireSensitiveAction(tx, session, workspace, 'member.role');
      const [selected] = await tx
        .select()
        .from(member)
        .where(and(eq(member.id, target), eq(member.organizationId, workspace)));
      if (!selected) throw new NotFoundException('Membre introuvable.');
      if (selected.role !== data.expectedRole)
        throw new ConflictException({ code: 'ROLE_CONFLICT' });
      if (selected.role === 'owner' && data.role === 'member') {
        const others = await tx.execute(
          sql`SELECT 1 FROM workspace_members WHERE workspace_id=${workspace}::uuid AND role='owner' AND id<>${target}::uuid`,
        );
        if (!others.rows.length) throw new ConflictException({ code: 'LAST_OWNER' });
      }
      await tx
        .update(member)
        .set({ role: data.role, updatedAt: new Date() })
        .where(eq(member.id, target));
      await tx.insert(auditLogs).values({
        workspaceId: workspace,
        actorId: principal.actor,
        action: 'member.role.changed',
        resourceType: 'member',
        resourceId: target,
        metadata: { previous: data.expectedRole, role: data.role },
      });
    });
    return { status: 'ok' };
  }
}
