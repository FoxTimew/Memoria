import { randomUUID } from 'node:crypto';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { actors, member, organization, pages } from '@memoria/db';
import type { WriteTransaction } from '@memoria/db';
import type { RequestContext } from '@memoria/contracts';
import { z } from 'zod';
export type StoredPage = typeof pages.$inferSelect;
export function uuid(value: string) {
  if (!z.uuid().safeParse(value).success) throw new BadRequestException('Identifiant invalide.');
  return value;
}
export async function contentContext(
  tx: WriteTransaction,
  userId: string,
  workspaceId: string,
  write: boolean,
): Promise<RequestContext> {
  uuid(workspaceId);
  if (write)
    await tx.execute(sql`select pg_advisory_xact_lock(hashtextextended(${workspaceId}::text, 0))`);
  else
    await tx.execute(
      sql`select pg_advisory_xact_lock_shared(hashtextextended(${workspaceId}::text, 0))`,
    );
  const [membership] = await tx
    .select({ id: member.id, role: member.role, actorId: actors.id })
    .from(member)
    .innerJoin(organization, eq(organization.id, member.organizationId))
    .innerJoin(
      actors,
      and(
        eq(actors.workspaceId, member.organizationId),
        eq(actors.userId, member.userId),
        eq(actors.kind, 'user'),
      ),
    )
    .where(
      and(
        eq(member.organizationId, workspaceId),
        eq(member.userId, userId),
        isNull(organization.deletedAt),
      ),
    )
    .orderBy(actors.createdAt)
    .limit(1);
  if (!membership || !['owner', 'member'].includes(membership.role))
    throw new NotFoundException('Espace inaccessible.');
  return {
    workspaceId,
    actorId: membership.actorId,
    requestId: randomUUID(),
    principal: {
      kind: 'member',
      memberId: membership.id,
      role: membership.role as 'owner' | 'member',
    },
  };
}
export function visible(page: StoredPage, all: readonly StoredPage[]): boolean {
  const seen = new Set<string>();
  let current: StoredPage | undefined = page;
  while (current) {
    if (current.deletedAt || seen.has(current.id)) return false;
    seen.add(current.id);
    if (!current.parentId) return true;
    current = all.find((item) => item.id === current!.parentId);
  }
  return false;
}
export function requirePage(
  id: string,
  all: readonly StoredPage[],
  includeTrash = false,
): StoredPage {
  const page = all.find((item) => item.id === uuid(id));
  if (!page || (!includeTrash && !visible(page, all)))
    throw new NotFoundException('Page inaccessible.');
  return page;
}
export function descendants(
  id: string,
  all: readonly { id: string; parentId: string | null }[],
): Set<string> {
  const found = new Set([id]);
  let changed = true;
  while (changed) {
    changed = false;
    for (const item of all)
      if (item.parentId && found.has(item.parentId) && !found.has(item.id)) {
        found.add(item.id);
        changed = true;
      }
  }
  return found;
}
