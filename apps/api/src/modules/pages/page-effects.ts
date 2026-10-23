import { randomUUID } from 'node:crypto';
import { and, eq } from 'drizzle-orm';
import { auditLogs, outboxEvents, searchDocuments, blocks } from '@memoria/db';
import type { WriteTransaction } from '@memoria/db';
import type { RequestContext, SystemContext } from '@memoria/contracts';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import type { StoredPage } from './content-access.ts';
import { visible } from './content-access.ts';
import { compareRank } from '../blocks/block-plan.ts';
export async function pageEffects(
  ctx: RequestContext | SystemContext,
  tx: WriteTransaction,
  page: StoredPage,
  all: StoredPage[],
  action: string,
  event: 'page.created' | 'page.updated' | 'block.updated' = 'page.updated',
) {
  const scope = and(
    eq(searchDocuments.workspaceId, ctx.workspaceId),
    eq(searchDocuments.pageId, page.id),
  );
  if (!visible(page, all)) await tx.delete(searchDocuments).where(scope);
  else {
    const rows = await tx
      .select()
      .from(blocks)
      .where(and(eq(blocks.workspaceId, ctx.workspaceId), eq(blocks.pageId, page.id)));
    const registry = createBlockRegistry();
    const text = [page.title];
    function walk(parentId: string | null) {
      for (const block of rows
        .filter((b) => b.parentId === parentId && !b.deletedAt)
        .sort(compareRank)) {
        try {
          text.push(
            registry
              .get(block.type)
              .toPlainText(registry.get(block.type).parse(block.content, block.schemaVersion)),
          );
        } catch {
          text.push('[Bloc non reconnu]');
        }
        walk(block.id);
      }
    }
    walk(null);
    const values = {
      workspaceId: ctx.workspaceId,
      pageId: page.id,
      plainText: text.join('\n'),
      pageVersion: page.version,
      updatedAt: new Date(),
    };
    await tx
      .insert(searchDocuments)
      .values(values)
      .onConflictDoUpdate({ target: searchDocuments.pageId, set: values });
  }
  await tx.insert(auditLogs).values({
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    action,
    resourceType: 'page',
    resourceId: page.id,
    metadata: { version: page.version },
  });
  const id = randomUUID();
  await tx.insert(outboxEvents).values({
    id,
    workspaceId: ctx.workspaceId,
    actorId: ctx.actorId,
    type: event,
    aggregateId: page.id,
    aggregateVersion: page.version,
    payload: {
      id,
      workspaceId: ctx.workspaceId,
      type: event,
      schemaVersion: 1,
      occurredAt: new Date().toISOString(),
      data: { pageId: page.id, pageVersion: page.version },
    },
  });
}
