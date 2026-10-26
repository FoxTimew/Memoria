import { Injectable, ConflictException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import { accessGrants, accessSubjects, auditLogs, member, pages } from '@memoria/db';
import { requireSensitiveAction, invitationPolicy } from '@memoria/auth';
import type { SessionIdentity } from '@memoria/auth';
import { shareUpdateSchema, accessPaginationSchema } from '@memoria/contracts';
import * as database from '../../database.module.ts';
import { accessInput, readManager } from './access-context.ts';
import { uuid, requirePage } from '../pages/content-access.ts';
import { shareState, predictedLevel } from '../pages/share-preview.ts';

@Injectable()
export class SharesService {
  constructor(private readonly database: database.DatabaseService) {}
  list(session: SessionIdentity, workspace: string, pageId: string, query: unknown) {
    uuid(pageId);
    const { limit, offset } = accessInput(accessPaginationSchema, query);
    return this.database.db.transaction(async (tx) => {
      await readManager(tx, session, workspace);
      const all = await tx.select().from(pages).where(eq(pages.workspaceId, workspace));
      const page = requirePage(pageId, all);
      const state = await shareState(tx, workspace);
      const ancestors = new Set<string>();
      let current: typeof page | undefined = page;
      while (current) {
        ancestors.add(current.id);
        current = all.find((p) => p.id === current!.parentId);
      }
      return {
        accessVersion: state.version,
        guests: state.guests.slice(offset, offset + limit).map((guest) => {
          const sources = state.grants.filter(
            (g) =>
              g.member === guest.member &&
              ancestors.has(g.page) &&
              (g.page === pageId || g.inherit),
          );
          const level = predictedLevel(page, all, state.grants, guest.member);
          return {
            memberId: guest.member,
            name: guest.name,
            level: level === 'none' ? null : level,
            direct: sources.find((g) => g.page === pageId)?.level ?? null,
            sources: sources.map((g) => ({
              pageId: g.page,
              title: all.find((p) => p.id === g.page)!.title,
              level: g.level,
            })),
          };
        }),
      };
    });
  }
  change(
    session: SessionIdentity,
    workspace: string,
    pageId: string,
    target: string,
    input: unknown,
  ) {
    uuid(workspace);
    uuid(pageId);
    uuid(target);
    const data = accessInput(shareUpdateSchema, input);
    return this.database.db.transaction(async (tx) => {
      const actor = await requireSensitiveAction(tx, session, workspace, 'workspace.access');
      const all = await tx.select().from(pages).where(eq(pages.workspaceId, workspace));
      requirePage(pageId, all);
      const [guest] = await tx
        .select()
        .from(member)
        .where(
          and(
            eq(member.organizationId, workspace),
            eq(member.id, target),
            eq(member.role, 'guest'),
          ),
        );
      if (!guest) throw new NotFoundException({ code: 'GUEST_UNAVAILABLE' });
      const state = await shareState(tx, workspace);
      if (state.version !== data.expectedAccessVersion)
        throw new ConflictException({ code: 'ACCESS_VERSION_CONFLICT' });
      const existing = state.grants.find((g) => g.member === target && g.page === pageId);
      if (data.level && !existing) {
        const limits = invitationPolicy();
        if (
          state.grants.filter((g) => g.member === target).length >= limits.GUEST_MAX_SHARED_ROOTS ||
          state.grants.length >= limits.WORKSPACE_MAX_SHARES
        )
          throw new ConflictException({ code: 'SHARE_CAPACITY' });
      }
      if (existing?.level === data.level || (!existing && !data.level))
        return { status: 'unchanged' };
      const [subject] = await tx
        .insert(accessSubjects)
        .values({
          workspaceId: workspace,
          kind: 'member',
          memberId: target,
          createdBy: actor.actor,
          updatedBy: actor.actor,
        })
        .onConflictDoUpdate({
          target: [accessSubjects.workspaceId, accessSubjects.memberId],
          set: { deletedAt: null, updatedBy: actor.actor },
        })
        .returning();
      await tx
        .delete(accessGrants)
        .where(
          and(
            eq(accessGrants.workspaceId, workspace),
            eq(accessGrants.subjectId, subject!.id),
            eq(accessGrants.resourceId, pageId),
            isNull(accessGrants.deletedAt),
          ),
        );
      if (data.level)
        await tx.insert(accessGrants).values({
          workspaceId: workspace,
          subjectId: subject!.id,
          resourceId: pageId,
          level: data.level,
          inherit: true,
          createdBy: actor.actor,
          updatedBy: actor.actor,
        });
      await tx.insert(auditLogs).values({
        workspaceId: workspace,
        actorId: actor.actor,
        action: 'page.share.changed',
        resourceType: 'page',
        resourceId: pageId,
        metadata: { memberId: target, previous: existing?.level ?? null, level: data.level },
      });
      return { status: 'ok' };
    });
  }
}
