import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { blocks, pages, searchDocuments } from '@memoria/db';
import type { WriteTransaction } from '@memoria/db';
import {
  internalPageCreateSchema,
  pageSaveSchema,
  pageMoveSchema,
  pageVersionInputSchema,
} from '@memoria/contracts';
import type { RequestContext } from '@memoria/contracts';
import { z } from 'zod';
import * as database from '../../database.module.ts';
import * as writer from '../blocks/block-write.service.ts';
import { contentContext, descendants, requirePage, visible } from './content-access.ts';
import type { StoredPage } from './content-access.ts';
import { compareRank, positionAfter } from '../blocks/block-plan.ts';
import { pageEffects } from './page-effects.ts';

function parse<T>(schema: z.ZodType<T>, input: unknown): T {
  const result = schema.safeParse(input);
  if (!result.success) throw new BadRequestException('Requête de page invalide.');
  return result.data;
}
export function pageResponse(page: StoredPage) {
  return {
    id: page.id,
    workspaceId: page.workspaceId,
    parentId: page.parentId,
    title: page.title,
    position: page.position,
    version: page.version,
    createdAt: page.createdAt.toISOString(),
    updatedAt: page.updatedAt.toISOString(),
    deletedAt: page.deletedAt?.toISOString() ?? null,
  };
}
@Injectable()
export class PagesService {
  constructor(
    private readonly database: database.DatabaseService,
    private readonly writer: writer.BlockWriteService,
  ) {}
  private run<T>(
    userId: string,
    workspaceId: string,
    write: boolean,
    work: (tx: WriteTransaction, ctx: RequestContext, all: StoredPage[]) => Promise<T>,
  ) {
    return this.database.db.transaction(async (tx) => {
      const ctx = await contentContext(tx, userId, workspaceId, write);
      const all = await tx
        .select()
        .from(pages)
        .where(eq(pages.workspaceId, workspaceId))
        .orderBy(pages.id);
      return work(tx, ctx, all);
    });
  }
  list(userId: string, workspaceId: string) {
    return this.run(userId, workspaceId, false, async (_tx, _ctx, all) => ({
      pages: all
        .filter((p) => visible(p, all))
        .sort(compareRank)
        .map(pageResponse),
      trash: all.filter((p) => p.deletedAt).map(pageResponse),
    }));
  }
  get(userId: string, workspaceId: string, pageId: string, versionOnly = false) {
    return this.run(userId, workspaceId, false, async (tx, _ctx, all) => {
      const page = requirePage(pageId, all);
      if (versionOnly) return { version: page.version };
      const content = await tx
        .select({
          id: blocks.id,
          parentId: blocks.parentId,
          position: blocks.position,
          type: blocks.type,
          schemaVersion: blocks.schemaVersion,
          content: blocks.content,
        })
        .from(blocks)
        .where(
          and(
            eq(blocks.workspaceId, workspaceId),
            eq(blocks.pageId, pageId),
            isNull(blocks.deletedAt),
          ),
        )
        .orderBy(blocks.position);
      return { page: pageResponse(page), blocks: content };
    });
  }
  create(userId: string, workspaceId: string, input: unknown) {
    const data = parse(internalPageCreateSchema, input);
    return this.run(userId, workspaceId, true, async (tx, ctx, all) => {
      if (all.length >= 1000)
        throw new BadRequestException('Maximum 1000 pages par espace pour cette tranche.');
      if (data.parentId) requirePage(data.parentId, all);
      this.checkDepth(data.parentId, all, 1);
      const siblings = all.filter((p) => p.parentId === data.parentId && !p.deletedAt);
      const previous = new Map(siblings.map((p) => [p.id, p.position]));
      const position = positionAfter(
        siblings,
        data.afterId === undefined ? (siblings.sort(compareRank).at(-1)?.id ?? null) : data.afterId,
      );
      await this.persistRebalanced(tx, ctx, all, previous);
      const [page] = await tx
        .insert(pages)
        .values({
          workspaceId,
          parentId: data.parentId,
          title: data.title,
          position,
          createdBy: ctx.actorId,
          updatedBy: ctx.actorId,
        })
        .returning();
      if (!page) throw new Error('Page insert failed');
      await pageEffects(ctx, tx, page, [...all, page], 'page.created', 'page.created');
      return pageResponse(page);
    });
  }
  save(userId: string, workspaceId: string, pageId: string, input: unknown) {
    const data = parse(pageSaveSchema, input);
    if (data.operations.length)
      throw new ConflictException({
        code: 'COLLABORATION_REQUIRED',
        message:
          'Le contenu utilise maintenant la collaboration ; utilisez la commande de contenu avec sa révision.',
      });
    return this.rename(userId, workspaceId, pageId, {
      expectedVersion: data.expectedVersion,
      title: data.title,
    });
  }
  rename(userId: string, workspaceId: string, pageId: string, input: unknown) {
    const data = parse(
      z.strictObject({ expectedVersion: z.int().positive(), title: z.string().max(500) }),
      input,
    );
    return this.run(userId, workspaceId, true, async (tx, ctx, all) => {
      const page = requirePage(pageId, all);
      if (page.version !== data.expectedVersion)
        throw new ConflictException({ code: 'VERSION_CONFLICT' });
      const [updated] = await tx
        .update(pages)
        .set({ title: data.title, version: sql`${pages.version} + 1`, updatedBy: ctx.actorId })
        .where(
          and(
            eq(pages.id, pageId),
            eq(pages.workspaceId, workspaceId),
            eq(pages.version, data.expectedVersion),
          ),
        )
        .returning();
      if (!updated) throw new ConflictException({ code: 'VERSION_CONFLICT' });
      await pageEffects(
        ctx,
        tx,
        updated,
        all.map((p) => (p.id === pageId ? updated : p)),
        'page.renamed',
      );
      return { pageId, version: updated.version, changedBlockIds: [] };
    });
  }
  openCollaboration(
    session: import('../auth/current-user.decorator.ts').AuthenticatedSession,
    workspace: string,
    page: string,
  ) {
    return this.writer.open(session, workspace, page);
  }
  writeCollaboration(
    session: import('../auth/current-user.decorator.ts').AuthenticatedSession,
    workspace: string,
    page: string,
    input: unknown,
  ) {
    return this.writer.write(session, workspace, page, input);
  }
  mutate(
    userId: string,
    workspaceId: string,
    pageId: string,
    action: 'move' | 'archive' | 'restore',
    input: unknown,
  ) {
    const data = parse(
      pageVersionInputSchema,
      action === 'move' ? { expectedVersion: parse(pageMoveSchema, input).expectedVersion } : input,
    );
    const move = action === 'move' ? parse(pageMoveSchema, input) : undefined;
    return this.run(userId, workspaceId, true, async (tx, ctx, all) => {
      const page = requirePage(pageId, all, action === 'restore');
      if (page.version !== data.expectedVersion)
        throw new ConflictException({ code: 'VERSION_CONFLICT', message: 'La page a changé.' });
      const affected = descendants(page.id, all);
      const previous = new Map(all.map((p) => [p.id, p.position]));
      if (action === 'archive') page.deletedAt = new Date();
      if (action === 'restore') {
        if (!page.deletedAt) throw new BadRequestException('Page déjà active.');
        if (page.parentId) requirePage(page.parentId, all);
        page.deletedAt = null;
        const siblings = all
          .filter((p) => p.id !== page.id && p.parentId === page.parentId && !p.deletedAt)
          .sort(compareRank);
        page.position = positionAfter(siblings, siblings.at(-1)?.id ?? null);
      }
      if (move) {
        if (move.parentId) requirePage(move.parentId, all);
        if (move.parentId && affected.has(move.parentId))
          throw new BadRequestException('Une page ne peut pas devenir son propre descendant.');
        page.parentId = move.parentId;
        for (const child of all.filter((p) => affected.has(p.id)))
          this.checkDepth(child.parentId, all, 1);
        page.position = positionAfter(
          all.filter((p) => p.id !== page.id && p.parentId === page.parentId && !p.deletedAt),
          move.afterId,
        );
      }
      // Ranks rebalanced on unaffected siblings are observable too.
      // Vacate the target rank first when moving within the same sibling list.
      // The final CAS and every intermediate rank are in this same transaction.
      if (action === 'move')
        await tx
          .update(pages)
          .set({ position: `Z${page.id.replaceAll('-', '')}` })
          .where(and(eq(pages.workspaceId, workspaceId), eq(pages.id, page.id)));
      for (const id of affected) previous.delete(id);
      await this.persistRebalanced(tx, ctx, all, previous);
      for (const target of all
        .filter((p) => affected.has(p.id))
        .sort((a, b) => a.id.localeCompare(b.id))) {
        const [updated] = await tx
          .update(pages)
          .set({
            parentId: target.parentId,
            position: target.position,
            deletedAt: target.deletedAt,
            version: sql`${pages.version} + 1`,
            updatedBy: ctx.actorId,
          })
          .where(
            and(
              eq(pages.workspaceId, workspaceId),
              eq(pages.id, target.id),
              eq(pages.version, target.version),
            ),
          )
          .returning();
        if (!updated) throw new ConflictException({ code: 'VERSION_CONFLICT' });
        Object.assign(target, updated);
        await pageEffects(ctx, tx, target, all, `page.${action}`);
      }
      return pageResponse(page);
    });
  }
  search(userId: string, workspaceId: string, query: string) {
    if (typeof query !== 'string' || query.trim().length < 1 || query.length > 200)
      throw new BadRequestException('Recherche attendue : 1 à 200 caractères.');
    return this.run(userId, workspaceId, false, async (tx, _ctx, all) => {
      const matches = await tx
        .select({
          id: pages.id,
          title: pages.title,
          excerpt: sql<string>`left(${searchDocuments.plainText}, 240)`,
        })
        .from(searchDocuments)
        .innerJoin(
          pages,
          and(
            eq(pages.id, searchDocuments.pageId),
            eq(pages.workspaceId, searchDocuments.workspaceId),
          ),
        )
        .where(
          and(
            eq(searchDocuments.workspaceId, workspaceId),
            sql`${searchDocuments.vector} @@ plainto_tsquery('simple', ${query})`,
          ),
        )
        .orderBy(pages.updatedAt)
        .limit(100);
      const allowed = new Set(all.filter((p) => visible(p, all)).map((p) => p.id));
      return matches.filter((m) => allowed.has(m.id));
    });
  }
  private checkDepth(parentId: string | null, all: StoredPage[], depth: number) {
    const seen = new Set<string>();
    let current = parentId;
    while (current) {
      if (seen.has(current) || ++depth > 50)
        throw new BadRequestException('Cycle ou profondeur supérieure à 50.');
      seen.add(current);
      current = all.find((p) => p.id === current)?.parentId ?? null;
    }
  }
  private async persistRebalanced(
    tx: WriteTransaction,
    ctx: RequestContext,
    all: StoredPage[],
    previous: Map<string, string>,
  ) {
    const changed = all.filter((p) => previous.has(p.id) && p.position !== previous.get(p.id));
    for (const p of changed)
      await tx
        .update(pages)
        .set({ position: `Z${p.id.replaceAll('-', '')}` })
        .where(and(eq(pages.workspaceId, ctx.workspaceId), eq(pages.id, p.id)));
    for (const p of changed) {
      const [updated] = await tx
        .update(pages)
        .set({ position: p.position, version: sql`${pages.version} + 1`, updatedBy: ctx.actorId })
        .where(and(eq(pages.workspaceId, ctx.workspaceId), eq(pages.id, p.id)))
        .returning();
      if (updated) {
        Object.assign(p, updated);
        await pageEffects(ctx, tx, p, all, 'page.order.rebalanced');
      }
    }
  }
}
