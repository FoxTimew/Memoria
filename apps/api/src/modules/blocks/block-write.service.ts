import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { and, eq, inArray, isNull, sql } from 'drizzle-orm';
import { blocks, pages, files, fileReferences } from '@memoria/db';
import type { WriteTransaction } from '@memoria/db';
import type { RequestContext, SystemContext, PageSave } from '@memoria/contracts';
import { canonicalJson } from '@memoria/contracts';
import { planBlocks } from './block-plan.ts';
import { requirePage } from '../pages/content-access.ts';
import { pageEffects } from '../pages/page-effects.ts';

@Injectable()
export class BlockWriteService {
  /** Caller owns the transaction and revalidates the context under the workspace lock. */
  async apply(
    ctx: RequestContext | SystemContext,
    tx: WriteTransaction,
    input: PageSave & { pageId: string },
  ) {
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ctx.workspaceId}::text, 0))`,
    );
    const all = await tx
      .select()
      .from(pages)
      .where(eq(pages.workspaceId, ctx.workspaceId))
      .orderBy(pages.id)
      .for('update');
    const page = requirePage(input.pageId, all);
    if (page.version !== input.expectedVersion)
      throw new ConflictException({
        code: 'VERSION_CONFLICT',
        message: 'La page a changé. Votre brouillon est conservé.',
      });
    const scope = and(eq(blocks.workspaceId, ctx.workspaceId), eq(blocks.pageId, page.id));
    const previous = await tx.select().from(blocks).where(scope);
    const next = planBlocks(previous, input.operations);
    const changed = next.filter((block) => {
      const old = previous.find((b) => b.id === block.id);
      return (
        !old ||
        ['type', 'schemaVersion', 'content', 'parentId', 'position'].some(
          (key) =>
            canonicalJson(block[key as keyof typeof block]) !==
            canonicalJson(old[key as keyof typeof block]),
        ) ||
        block.deletedAt?.getTime() !== old.deletedAt?.getTime()
      );
    });
    if (!changed.length && input.title === page.title)
      return { pageId: page.id, version: page.version, changedBlockIds: [] };
    const inserted = changed.filter((b) => !previous.some((p) => p.id === b.id)).map((b) => b.id);
    if (
      inserted.length &&
      (await tx.select({ id: blocks.id }).from(blocks).where(inArray(blocks.id, inserted)).limit(1))
        .length
    )
      throw new ConflictException('Identifiant de bloc déjà utilisé.');
    const imageBlocks = next.filter(
      (b) => !b.deletedAt && b.type === 'core.image' && b.content.fileId,
    );
    const fileIds = [...new Set(imageBlocks.map((b) => String(b.content.fileId)))];
    if (fileIds.length) {
      const ready = await tx
        .select({ id: files.id })
        .from(files)
        .where(
          and(
            eq(files.workspaceId, ctx.workspaceId),
            inArray(files.id, fileIds),
            eq(files.state, 'ready'),
            isNull(files.deletedAt),
          ),
        );
      if (ready.length !== fileIds.length)
        throw new BadRequestException('Fichier absent de cet espace ou non disponible.');
    }
    const [updated] = await tx
      .update(pages)
      .set({ title: input.title, version: sql`${pages.version} + 1`, updatedBy: ctx.actorId })
      .where(
        and(
          eq(pages.workspaceId, ctx.workspaceId),
          eq(pages.id, page.id),
          eq(pages.version, input.expectedVersion),
        ),
      )
      .returning();
    if (!updated) throw new ConflictException({ code: 'VERSION_CONFLICT' });
    // Transaction-local detachment permits valid swaps without transient rank collisions/cycles.
    const existing = changed.filter((b) => previous.some((p) => p.id === b.id));
    if (existing.length)
      await tx
        .update(blocks)
        .set({ parentId: null, deletedAt: new Date() })
        .where(
          and(
            scope,
            inArray(
              blocks.id,
              existing.map((b) => b.id),
            ),
          ),
        );
    const pending = new Map(changed.map((b) => [b.id, b]));
    while (pending.size) {
      const block = [...pending.values()].find((b) => !b.parentId || !pending.has(b.parentId));
      if (!block) throw new BadRequestException('Cycle de blocs.');
      if (previous.some((b) => b.id === block.id))
        await tx
          .update(blocks)
          .set({ ...block, updatedBy: ctx.actorId })
          .where(and(scope, eq(blocks.id, block.id)));
      else
        await tx.insert(blocks).values({
          ...block,
          pageId: page.id,
          workspaceId: ctx.workspaceId,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        });
      pending.delete(block.id);
    }
    await tx
      .update(fileReferences)
      .set({ deletedAt: new Date(), updatedBy: ctx.actorId })
      .where(
        and(
          eq(fileReferences.workspaceId, ctx.workspaceId),
          eq(fileReferences.pageId, page.id),
          isNull(fileReferences.deletedAt),
        ),
      );
    if (imageBlocks.length)
      await tx.insert(fileReferences).values(
        imageBlocks.map((b) => ({
          workspaceId: ctx.workspaceId,
          fileId: String(b.content.fileId),
          pageId: page.id,
          blockId: b.id,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })),
      );
    await pageEffects(
      ctx,
      tx,
      updated,
      all.map((p) => (p.id === updated.id ? updated : p)),
      'page.content.updated',
      'block.updated',
    );
    return { pageId: page.id, version: updated.version, changedBlockIds: changed.map((b) => b.id) };
  }
  /** Future retention worker entry; no HTTP route. */
  async purge(ctx: SystemContext, tx: WriteTransaction, pageId: string) {
    if (ctx.principal.purpose !== 'retention')
      throw new BadRequestException('Purge réservée à la rétention.');
    await tx.execute(
      sql`select pg_advisory_xact_lock(hashtextextended(${ctx.workspaceId}::text, 0))`,
    );
    const [page] = await tx
      .select()
      .from(pages)
      .where(and(eq(pages.workspaceId, ctx.workspaceId), eq(pages.id, pageId)))
      .for('update');
    if (!page?.deletedAt) throw new BadRequestException('Page non archivée.');
    await tx
      .delete(blocks)
      .where(and(eq(blocks.workspaceId, ctx.workspaceId), eq(blocks.pageId, pageId)));
  }
}
