import { randomUUID } from 'node:crypto';
import { and, eq, inArray, sql } from 'drizzle-orm';
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
  return pageEffectsMany(ctx, tx, [page], all, action, event);
}
/** Same effects and projection mutexes, grouped inside the existing transaction. */
export async function pageEffectsMany(
  ctx: RequestContext | SystemContext,
  tx: WriteTransaction,
  changed: StoredPage[],
  all: StoredPage[],
  action: string,
  event: 'page.created' | 'page.updated' | 'block.updated' = 'page.updated',
) {
  if (!changed.length) return;
  await tx.execute(
    sql`WITH targets AS MATERIALIZED (SELECT id FROM unnest(${sql.param(changed.map((p) => p.id))}::uuid[]) id ORDER BY id)
        SELECT pg_advisory_xact_lock(hashtextextended('projection:' || id::text,0)) FROM targets`,
  );
  const visiblePages = changed.filter((page) => visible(page, all));
  const hidden = changed.filter((page) => !visiblePages.includes(page));
  if (hidden.length)
    await tx.delete(searchDocuments).where(
      and(
        eq(searchDocuments.workspaceId, ctx.workspaceId),
        inArray(
          searchDocuments.pageId,
          hidden.map((page) => page.id),
        ),
      ),
    );
  if (visiblePages.length) {
    const rows = await tx
      .select()
      .from(blocks)
      .where(
        and(
          eq(blocks.workspaceId, ctx.workspaceId),
          inArray(
            blocks.pageId,
            visiblePages.map((page) => page.id),
          ),
        ),
      );
    const registry = createBlockRegistry();
    const values = visiblePages.map((page) => {
      const own = rows.filter((block) => block.pageId === page.id);
      const text = [page.title];
      function walk(parentId: string | null) {
        for (const block of own
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
      return {
        workspaceId: ctx.workspaceId,
        pageId: page.id,
        plainText: text.join('\n'),
        pageVersion: page.version,
        updatedAt: new Date(),
      };
    });
    await tx
      .insert(searchDocuments)
      .values(values)
      .onConflictDoUpdate({
        target: searchDocuments.pageId,
        set: {
          workspaceId: sql`excluded.workspace_id`,
          plainText: sql`excluded.plain_text`,
          pageVersion: sql`excluded.page_version`,
          updatedAt: sql`excluded.updated_at`,
        },
      });
  }
  await tx.insert(auditLogs).values(
    changed.map((page) => ({
      workspaceId: ctx.workspaceId,
      actorId: ctx.actorId,
      action,
      resourceType: 'page',
      resourceId: page.id,
      metadata: { version: page.version },
    })),
  );
  await tx.insert(outboxEvents).values(
    changed.map((page) => {
      const id = randomUUID();
      return {
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
      };
    }),
  );
}
