import {
  Injectable,
  ConflictException,
  NotFoundException,
  HttpException,
  ForbiddenException,
} from '@nestjs/common';
import { and, eq, sql, inArray } from 'drizzle-orm';
import { z } from 'zod';
import {
  invitation,
  invitationPages,
  actors,
  accessSubjects,
  accessGrants,
  auditLogs,
  pages,
  member,
} from '@memoria/db';
import type { WriteTransaction } from '@memoria/db';
import {
  requireSensitiveAction,
  invitationPolicy,
  queueAuthMail,
  consumeBucket,
  throttleKey,
  emailBudget,
} from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import {
  invitationCreateSchema,
  invitationIdSchema,
  accessPaginationSchema,
} from '@memoria/contracts';
import type { InvitationSummary } from '@memoria/contracts';
import * as database from '../../database.module.ts';
import * as auth from '../auth/auth.service.ts';
import { readConfig } from '../../config.ts';
import { pageRights, requirePageRight, uuid } from '../pages/content-access.ts';
import { accessInput, lockAccessIdentity, readManager, mayManageRole } from './access-context.ts';

type Stored = typeof invitation.$inferSelect;
type Root = { pageId: string; level: 'read' | 'edit' };
@Injectable()
export class InvitationsService {
  constructor(
    private readonly database: database.DatabaseService,
    private readonly auth: auth.AuthService,
  ) {}
  async expire(tx: WriteTransaction, workspace: string) {
    await tx.execute(
      sql`UPDATE workspace_invitations SET status='expired' WHERE workspace_id=${workspace}::uuid AND status='pending' AND expires_at<=clock_timestamp()`,
    );
  }
  async roots(tx: WriteTransaction, id: string): Promise<Root[]> {
    return (
      await tx
        .select({ pageId: invitationPages.pageId, level: invitationPages.level })
        .from(invitationPages)
        .where(eq(invitationPages.invitationId, id))
    ).map((r) => ({ ...r, level: r.level as Root['level'] }));
  }
  async checkRoots(
    tx: WriteTransaction,
    session: SessionIdentity,
    workspace: string,
    roots: Root[],
  ) {
    if (!roots.length) return;
    const selected = await tx
      .select()
      .from(pages)
      .where(
        and(
          eq(pages.workspaceId, workspace),
          inArray(
            pages.id,
            roots.map((r) => r.pageId),
          ),
        ),
      );
    const rights = await pageRights(tx, session, workspace, selected);
    for (const root of roots) requirePageRight(rights, root.pageId);
  }
  async checkGrantCapacity(tx: WriteTransaction, workspace: string, count: number) {
    const limits = invitationPolicy();
    const row = (
      await tx.execute(
        sql`SELECT count(*) AS n FROM access_grants WHERE workspace_id=${workspace}::uuid AND deleted_at IS NULL`,
      )
    ).rows[0]!;
    if (
      count > limits.GUEST_MAX_SHARED_ROOTS ||
      Number(row.n) + count > limits.WORKSPACE_MAX_SHARES
    )
      throw new ConflictException({ code: 'SHARE_CAPACITY' });
  }
  private async summary(
    tx: WriteTransaction,
    row: Stored,
    management: boolean,
  ): Promise<InvitationSummary> {
    const workspace = (
      await tx.execute<{ name: string }>(
        sql`SELECT name FROM workspaces WHERE id=${row.organizationId}::uuid`,
      )
    ).rows[0]!;
    const live = row.status === 'pending' && row.expiresAt.getTime() > Date.now();
    return {
      id: row.id,
      workspaceId: row.organizationId,
      workspaceName: workspace.name,
      role: row.role as InvitationSummary['role'],
      status: row.status === 'pending' && !live ? 'expired' : row.status,
      expiresAt: row.expiresAt.toISOString(),
      deliveryStatus: row.deliveryStatus,
      ...(management
        ? {
            email: row.email,
            roots: await this.roots(tx, row.id),
            ...(live ? { link: `${readConfig().APP_ORIGIN}/invitation#id=${row.id}` } : {}),
          }
        : {}),
    };
  }
  async list(session: SessionIdentity, workspace: string, query: unknown) {
    const { limit, offset } = accessInput(accessPaginationSchema, query);
    return this.database.db.transaction(async (tx) => {
      await readManager(tx, session, workspace);
      const selected = await tx
        .select()
        .from(invitation)
        .where(eq(invitation.organizationId, workspace))
        .orderBy(invitation.createdAt, invitation.id)
        .limit(limit)
        .offset(offset);
      return Promise.all(selected.map((row) => this.summary(tx, row, true)));
    });
  }
  async own(session: SessionIdentity, query: unknown) {
    const { limit, offset } = accessInput(accessPaginationSchema, query);
    return this.database.db.transaction(async (tx) => {
      const user = await lockAccessIdentity(tx, session);
      const selected = await tx
        .select()
        .from(invitation)
        .where(
          and(
            eq(invitation.email, user.email.toLowerCase()),
            eq(invitation.status, 'pending'),
            sql`${invitation.expiresAt}>clock_timestamp()`,
          ),
        )
        .orderBy(invitation.createdAt, invitation.id)
        .limit(limit)
        .offset(offset);
      const result: InvitationSummary[] = [];
      for (const row of selected)
        if (await this.validInviter(tx, row)) result.push(await this.summary(tx, row, false));
      return result;
    });
  }
  private async validInviter(tx: WriteTransaction, row: Stored) {
    const found = (
      await tx.execute<{
        role: string;
      }>(sql`SELECT m.role FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL
      WHERE m.workspace_id=${row.organizationId}::uuid AND m.user_id=${row.inviterId}::uuid`)
    ).rows[0];
    return (
      !!found &&
      (found.role === 'owner' ||
        (found.role === 'admin' && ['member', 'guest'].includes(row.role ?? '')))
    );
  }
  private async destination(tx: WriteTransaction, session: SessionIdentity, id: string) {
    const user = await lockAccessIdentity(tx, session);
    const first = (await tx.select().from(invitation).where(eq(invitation.id, id)))[0];
    if (!first || first.email.toLowerCase() !== user.email.toLowerCase())
      throw new NotFoundException({ code: 'INVITATION_UNAVAILABLE' });
    await tx.execute(
      sql`SELECT pg_advisory_xact_lock(hashtextextended(${first.organizationId}::text,0))`,
    );
    await tx.execute(sql`SELECT database_lock_workspace(${first.organizationId}::uuid)`);
    const [row] = await tx.select().from(invitation).where(eq(invitation.id, id)).for('update');
    if (
      !row ||
      row.status !== 'pending' ||
      row.expiresAt.getTime() <= Date.now() ||
      !(await this.validInviter(tx, row))
    )
      throw new NotFoundException({ code: 'INVITATION_UNAVAILABLE' });
    return row;
  }
  async resolve(session: SessionIdentity, input: unknown) {
    const { id } = accessInput(invitationIdSchema, input);
    return this.database.db.transaction(async (tx) =>
      this.summary(tx, await this.destination(tx, session, id), false),
    );
  }
  private async mailBudget(tx: WriteTransaction, workspace: string, email: string) {
    const secret = readConfig().BETTER_AUTH_SECRET;
    const workspaceBudget = await consumeBucket(
      tx,
      throttleKey(secret, 'invitation:workspace', workspace),
      200,
      86400,
    );
    if (!workspaceBudget.allowed)
      throw new HttpException(
        { code: 'INVITATION_MAIL_LIMITED', retryAfter: workspaceBudget.retry },
        429,
      );
    // Commit the send budget with its durable job. Never borrow a second pool
    // connection while holding transaction locks (concurrent requests can exhaust it).
    // HTTP/account admission remains independent and survives business rollback.
    return emailBudget(tx, secret, 'invitation', email);
  }
  async create(
    session: SessionIdentity,
    headers: Headers,
    workspace: string,
    input: unknown,
    replace?: string,
  ) {
    uuid(workspace);
    if (replace) uuid(replace);
    const supplied = replace
      ? (accessInput(z.strictObject({}), input), undefined)
      : accessInput(invitationCreateSchema, input);
    return this.database.db.transaction(async (tx) => {
      const principal = await requireSensitiveAction(tx, session, workspace, 'workspace.access');
      await this.expire(tx, workspace);
      let data = supplied;
      if (replace) {
        const previous = (
          await tx
            .select()
            .from(invitation)
            .where(and(eq(invitation.id, replace), eq(invitation.organizationId, workspace)))
        )[0];
        if (!previous || !['pending', 'expired'].includes(previous.status))
          throw new NotFoundException({ code: 'INVITATION_UNAVAILABLE' });
        mayManageRole(principal, previous.role!);
        data = accessInput(invitationCreateSchema, {
          email: previous.email,
          role: previous.role,
          roots: await this.roots(tx, previous.id),
        });
        await this.auth
          .inTransaction(tx)
          .api.cancelInvitation({ headers, body: { invitationId: previous.id } });
      }
      if (!data) throw new Error('Missing invitation input');
      mayManageRole(principal, data.role);
      await this.checkRoots(tx, session, workspace, data.roots);
      await this.checkGrantCapacity(tx, workspace, data.roots.length);
      const limits = invitationPolicy();
      const counts = (
        await tx.execute(sql`SELECT
        (SELECT count(*) FROM workspace_invitations WHERE workspace_id=${workspace}::uuid AND status='pending') AS pending,
        (SELECT count(*) FROM workspace_members WHERE workspace_id=${workspace}::uuid) AS members,
        EXISTS(SELECT 1 FROM workspace_members m JOIN auth_users u ON u.id=m.user_id WHERE m.workspace_id=${workspace}::uuid AND lower(u.email)=${data.email}) AS present,
        EXISTS(SELECT 1 FROM workspace_invitations WHERE workspace_id=${workspace}::uuid AND status='pending' AND lower(email)=${data.email}) AS invited`)
      ).rows[0]!;
      if (counts.present) throw new ConflictException({ code: 'ALREADY_MEMBER' });
      if (counts.invited) throw new ConflictException({ code: 'ALREADY_INVITED' });
      if (
        Number(counts.pending) >= limits.WORKSPACE_MAX_PENDING_INVITATIONS ||
        Number(counts.members) >= limits.WORKSPACE_MAX_MEMBERS
      )
        throw new ConflictException({ code: 'INVITATION_CAPACITY' });
      const mailAllowed = await this.mailBudget(tx, workspace, data.email);
      const created = await this.auth.inTransaction(tx).api.createInvitation({
        headers,
        body: { organizationId: workspace, email: data.email, role: data.role },
      });
      if (data.roots.length)
        await tx.insert(invitationPages).values(
          data.roots.map((root) => ({
            workspaceId: workspace,
            invitationId: created.id,
            ...root,
          })),
        );
      const [saved] = await tx
        .update(invitation)
        .set({ deliveryStatus: mailAllowed ? 'queued' : 'limited' })
        .where(eq(invitation.id, created.id))
        .returning();
      if (mailAllowed)
        await queueAuthMail(
          tx,
          readConfig().BETTER_AUTH_SECRET,
          'invitation',
          {
            email: data.email,
            subject: 'Invitation à un studio — Memoria',
            text: `Vous êtes invité à rejoindre un studio. Connectez-vous avec cette adresse vérifiée, puis acceptez l’invitation :\n${readConfig().APP_ORIGIN}/invitation#id=${created.id}\nCe lien ne donne aucun accès sans votre compte.`,
          },
          undefined,
          new Date(
            Math.min(
              created.expiresAt.getTime(),
              Date.now() + limits.INVITATION_MAIL_TTL_HOURS * 3600000,
            ),
          ),
          false,
          created.id,
        );
      await tx.insert(auditLogs).values({
        workspaceId: workspace,
        actorId: principal.actor,
        action: replace ? 'invitation.resent' : 'invitation.created',
        resourceType: 'invitation',
        resourceId: created.id,
        metadata: { role: data.role, roots: data.roots.length },
      });
      return this.summary(tx, saved!, true);
    });
  }
  async cancel(
    session: SessionIdentity,
    headers: Headers,
    workspace: string,
    id: string,
    input: unknown,
  ) {
    uuid(workspace);
    uuid(id);
    accessInput(z.strictObject({}), input);
    return this.database.db.transaction(async (tx) => {
      const actor = await requireSensitiveAction(tx, session, workspace, 'workspace.access');
      const row = (
        await tx
          .select()
          .from(invitation)
          .where(and(eq(invitation.id, id), eq(invitation.organizationId, workspace)))
      )[0];
      if (!row || row.status !== 'pending')
        throw new NotFoundException({ code: 'INVITATION_UNAVAILABLE' });
      mayManageRole(actor, row.role!);
      await this.auth
        .inTransaction(tx)
        .api.cancelInvitation({ headers, body: { invitationId: id } });
      await tx.insert(auditLogs).values({
        workspaceId: workspace,
        actorId: actor.actor,
        action: 'invitation.canceled',
        resourceType: 'invitation',
        resourceId: id,
      });
      return { status: 'ok' };
    });
  }
  async respond(session: SessionIdentity, headers: Headers, input: unknown, accept: boolean) {
    const { id } = accessInput(invitationIdSchema, input);
    return this.database.db.transaction(async (tx) => {
      const row = await this.destination(tx, session, id);
      if (!accept) {
        await this.auth
          .inTransaction(tx)
          .api.rejectInvitation({ headers, body: { invitationId: id } });
        await tx.insert(auditLogs).values({
          workspaceId: row.organizationId,
          action: 'invitation.rejected',
          resourceType: 'invitation',
          resourceId: id,
        });
        return { status: 'rejected' };
      }
      const roots = await this.roots(tx, id),
        limits = invitationPolicy();
      if (row.role === 'guest' && !roots.length)
        throw new ConflictException({ code: 'INVITATION_PAGES_CHANGED' });
      // The invitee has no membership yet; validate live ancestry using the current inviter's
      // structural visibility, not by giving the invitee an artificial session/permission.
      for (const root of roots) {
        const visible = (
          await tx.execute(sql`WITH RECURSIVE chain AS (
          SELECT id,parent_id,deleted_at,1 depth FROM pages WHERE id=${root.pageId}::uuid AND workspace_id=${row.organizationId}::uuid
          UNION ALL SELECT p.id,p.parent_id,p.deleted_at,c.depth+1 FROM chain c JOIN pages p ON p.id=c.parent_id AND p.workspace_id=${row.organizationId}::uuid WHERE c.depth<51)
          SELECT 1 WHERE EXISTS(SELECT 1 FROM chain WHERE parent_id IS NULL) AND NOT EXISTS(SELECT 1 FROM chain WHERE deleted_at IS NOT NULL OR depth>50)`)
        ).rows.length;
        if (!visible) throw new ConflictException({ code: 'INVITATION_PAGES_CHANGED' });
      }
      const existing = await tx
        .select()
        .from(member)
        .where(
          and(eq(member.organizationId, row.organizationId), eq(member.userId, session.userId)),
        );
      if (existing.length) throw new ConflictException({ code: 'ALREADY_MEMBER' });
      const count = (
        await tx.execute(
          sql`SELECT count(*) n FROM workspace_members WHERE workspace_id=${row.organizationId}::uuid`,
        )
      ).rows[0]!;
      if (Number(count.n) >= limits.WORKSPACE_MAX_MEMBERS)
        throw new ConflictException({ code: 'INVITATION_CAPACITY' });
      await this.checkGrantCapacity(tx, row.organizationId, roots.length);
      const accepted = await this.auth
        .inTransaction(tx)
        .api.acceptInvitation({ headers, body: { invitationId: id } });
      if (accepted.member.userId !== session.userId)
        throw new ForbiddenException({ code: 'SESSION_CHANGED' });
      const [actor] = await tx
        .insert(actors)
        .values({ workspaceId: row.organizationId, kind: 'user', userId: session.userId })
        .returning();
      const [subject] = await tx
        .insert(accessSubjects)
        .values({
          workspaceId: row.organizationId,
          kind: 'member',
          memberId: accepted.member.id,
          createdBy: actor!.id,
          updatedBy: actor!.id,
        })
        .returning();
      if (roots.length)
        await tx.insert(accessGrants).values(
          roots.map((root) => ({
            workspaceId: row.organizationId,
            subjectId: subject!.id,
            resourceId: root.pageId,
            level: root.level,
            createdBy: actor!.id,
            updatedBy: actor!.id,
          })),
        );
      await tx.insert(auditLogs).values({
        workspaceId: row.organizationId,
        actorId: actor!.id,
        action: 'invitation.accepted',
        resourceType: 'invitation',
        resourceId: id,
        metadata: { role: row.role, roots: roots.length },
      });
      await queueAuthMail(
        tx,
        readConfig().BETTER_AUTH_SECRET,
        'delivery',
        {
          email: row.email,
          subject: 'Invitation acceptée — Memoria',
          text: 'Vous avez rejoint le studio. Sa politique de sécurité reste applicable avant l’accès aux documents.',
        },
        session.userId,
      );
      return this.arrivalIn(tx, session, row.organizationId);
    });
  }
  private async arrivalIn(tx: WriteTransaction, session: SessionIdentity, workspace: string) {
    const row = (
      await tx.execute<{
        role: string;
        allowed: boolean;
        required: boolean;
      }>(sql`SELECT m.role,auth_session_can_access_workspace(${session.id}::uuid,${workspace}::uuid) allowed,
      coalesce(p.require_strong_auth,false) required FROM workspace_members m JOIN workspaces w ON w.id=m.workspace_id AND w.deleted_at IS NULL LEFT JOIN workspace_policies p ON p.workspace_id=w.id
      WHERE m.workspace_id=${workspace}::uuid AND m.user_id=${session.userId}::uuid`)
    ).rows[0];
    if (!row) throw new NotFoundException({ code: 'WORKSPACE_INACCESSIBLE' });
    return {
      workspaceId: workspace,
      role: row.role,
      contentAllowed: row.allowed,
      requiresStrongAuth: !row.allowed && row.required,
    };
  }
  async arrival(session: SessionIdentity, workspace: string) {
    uuid(workspace);
    return this.database.db.transaction(async (tx) => {
      await lockAccessIdentity(tx, session);
      return this.arrivalIn(tx, session, workspace);
    });
  }
}
