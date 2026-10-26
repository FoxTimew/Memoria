import {
  Injectable,
  ConflictException,
  NotFoundException,
  ForbiddenException,
} from '@nestjs/common';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { member, accessSubjects, accessGrants, auditLogs } from '@memoria/db';
import { requireSensitiveAction } from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import {
  workspaceRoleSchema,
  workspaceRoleUpdateSchema,
  accessPaginationSchema,
} from '@memoria/contracts';
import * as database from '../../database.module.ts';
import * as auth from '../auth/auth.service.ts';
import * as invitations from './invitations.service.ts';
import { uuid } from '../pages/content-access.ts';
import { accessInput, readManager, mayManageRole } from './access-context.ts';
@Injectable()
export class MembersService {
  constructor(
    private readonly database: database.DatabaseService,
    private readonly auth: auth.AuthService,
    private readonly invitations: invitations.InvitationsService,
  ) {}
  async list(session: SessionIdentity, workspace: string, query: unknown) {
    const { limit, offset } = accessInput(accessPaginationSchema, query);
    return this.database.db.transaction(async (tx) => {
      await readManager(tx, session, workspace);
      const result = await tx.execute<{
        id: string;
        name: string;
        role: string;
        mfa_deadline: Date | null;
      }>(sql`SELECT m.id,u.name,m.role,m.mfa_deadline
        FROM workspace_members m JOIN auth_users u ON u.id=m.user_id WHERE m.workspace_id=${workspace}::uuid ORDER BY m.created_at,m.id LIMIT ${limit} OFFSET ${offset}`);
      return result.rows.map((row) => ({
        id: row.id,
        name: row.name,
        role: row.role,
        deadline: row.mfa_deadline ? new Date(row.mfa_deadline).toISOString() : null,
      }));
    });
  }
  async change(
    session: SessionIdentity,
    headers: Headers,
    workspace: string,
    target: string,
    input: unknown,
    remove = false,
  ) {
    uuid(workspace);
    uuid(target);
    const data = remove
      ? {
          ...accessInput(z.strictObject({ expectedRole: workspaceRoleSchema }), input),
          role: null,
          roots: [],
        }
      : accessInput(workspaceRoleUpdateSchema, input);
    return this.database.db.transaction(async (tx) => {
      const principal = await requireSensitiveAction(tx, session, workspace, 'member.role');
      const [selected] = await tx
        .select()
        .from(member)
        .where(and(eq(member.id, target), eq(member.organizationId, workspace)));
      if (!selected) throw new NotFoundException({ code: 'MEMBER_UNAVAILABLE' });
      if (selected.role !== data.expectedRole)
        throw new ConflictException({ code: 'ROLE_CONFLICT' });
      mayManageRole(principal, selected.role);
      if (data.role) mayManageRole(principal, data.role);
      if (principal.role === 'admin' && selected.userId === session.userId)
        throw new ForbiddenException({ code: 'OWNER_REQUIRED' });
      if (selected.role === 'owner' && data.role !== 'owner') {
        if (
          !(
            await tx.execute(
              sql`SELECT 1 FROM workspace_members WHERE workspace_id=${workspace}::uuid AND role='owner' AND id<>${target}::uuid`,
            )
          ).rows.length
        )
          throw new ConflictException({ code: 'LAST_OWNER' });
      }
      if (!remove && data.role === selected.role)
        throw new ConflictException({ code: 'ROLE_UNCHANGED' });
      if (data.role === 'guest') {
        await this.invitations.checkRoots(tx, session, workspace, data.roots);
        await this.invitations.checkGrantCapacity(tx, workspace, data.roots.length);
      }
      if (remove) {
        // Keep historical actors; retire credentials before removing their issuer FK.
        await tx.execute(
          sql`UPDATE api_keys SET enabled=false WHERE id IN (SELECT credential_id FROM api_key_policies WHERE workspace_id=${workspace}::uuid AND issuer_member_id=${target}::uuid)`,
        );
        await tx.execute(
          sql`UPDATE api_key_policies SET issuer_member_id=NULL,revoked_at=coalesce(revoked_at,clock_timestamp()) WHERE workspace_id=${workspace}::uuid AND issuer_member_id=${target}::uuid`,
        );
        await this.auth.inTransaction(tx).api.removeMember({
          headers,
          body: { organizationId: workspace, memberIdOrEmail: target },
        });
      } else {
        await this.auth.inTransaction(tx).api.updateMemberRole({
          headers,
          body: { organizationId: workspace, memberId: target, role: data.role! },
        });
        if (data.role === 'guest') {
          const [subject] = await tx
            .insert(accessSubjects)
            .values({
              workspaceId: workspace,
              kind: 'member',
              memberId: target,
              createdBy: principal.actor,
              updatedBy: principal.actor,
            })
            .onConflictDoUpdate({
              target: [accessSubjects.workspaceId, accessSubjects.memberId],
              set: { deletedAt: null, updatedBy: principal.actor },
            })
            .returning();
          await tx.delete(accessGrants).where(eq(accessGrants.subjectId, subject!.id));
          await tx.insert(accessGrants).values(
            data.roots.map((root) => ({
              workspaceId: workspace,
              subjectId: subject!.id,
              resourceId: root.pageId,
              level: root.level,
              createdBy: principal.actor,
              updatedBy: principal.actor,
            })),
          );
        }
      }
      await tx.insert(auditLogs).values({
        workspaceId: workspace,
        actorId: principal.actor,
        action: remove ? 'member.removed' : 'member.role.changed',
        resourceType: 'member',
        resourceId: target,
        metadata: { previous: selected.role, role: data.role, roots: data.roots.length },
      });
      return { status: 'ok' };
    });
  }
}
