import { generateKeyBetween, generateNKeysBetween } from 'fractional-indexing';
import { BadRequestException } from '@nestjs/common';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import type { BlockBatch } from '@memoria/contracts';
import type { blocks } from '@memoria/db';
import { descendants } from '../pages/content-access.ts';
export type BlockState = Pick<
  typeof blocks.$inferSelect,
  'id' | 'parentId' | 'position' | 'type' | 'schemaVersion' | 'content' | 'deletedAt'
>;
export const compareRank = (a: { position: string }, b: { position: string }) =>
  a.position < b.position ? -1 : a.position > b.position ? 1 : 0;
export function positionAfter<T extends { id: string; position: string }>(
  siblings: T[],
  afterId: string | null,
) {
  const sorted = [...siblings].sort(compareRank);
  const index = afterId === null ? -1 : sorted.findIndex((item) => item.id === afterId);
  if (afterId !== null && index < 0) throw new BadRequestException('Voisin absent de ce parent.');
  let key = generateKeyBetween(
    sorted[index]?.position ?? null,
    sorted[index + 1]?.position ?? null,
  );
  if (key.length > 128) {
    const keys = generateNKeysBetween(null, null, sorted.length);
    sorted.forEach((item, i) => {
      item.position = keys[i]!;
    });
    key = generateKeyBetween(sorted[index]?.position ?? null, sorted[index + 1]?.position ?? null);
  }
  return key;
}
export function planBlocks(
  previous: readonly BlockState[],
  operations: BlockBatch['operations'],
  now = new Date(),
): BlockState[] {
  const result = structuredClone([...previous]);
  const registry = createBlockRegistry();
  const get = (id: string) => {
    const block = result.find((b) => b.id === id);
    if (!block) throw new BadRequestException('Bloc absent de cette page.');
    return block;
  };
  for (const operation of operations) {
    if (operation.op === 'insert') {
      if (result.some((b) => b.id === operation.id))
        throw new BadRequestException('Identifiant de bloc déjà utilisé.');
      result.push({
        id: operation.id,
        parentId: operation.parentId,
        position: 'a0',
        type: operation.type,
        schemaVersion: operation.schemaVersion,
        content: operation.content as BlockState['content'],
        deletedAt: null,
      });
    }
    const block = get(operation.id);
    if (block.deletedAt && operation.op !== 'restore')
      throw new BadRequestException('Bloc archivé.');
    if (operation.op === 'archive') {
      const ids = descendants(block.id, result);
      for (const item of result) if (ids.has(item.id) && !item.deletedAt) item.deletedAt = now;
    } else if (operation.op === 'update') {
      block.type = operation.type ?? block.type;
      block.schemaVersion = operation.schemaVersion;
      block.content = operation.content as BlockState['content'];
    } else {
      if (operation.op === 'restore') {
        if (!block.deletedAt) throw new BadRequestException('Bloc déjà actif.');
        const stamp = block.deletedAt.getTime();
        const ids =
          operation.withDescendants === false ? new Set([block.id]) : descendants(block.id, result);
        for (const item of result)
          if (ids.has(item.id) && item.deletedAt?.getTime() === stamp) item.deletedAt = null;
      }
      if (operation.parentId === block.id) throw new BadRequestException('Cycle de blocs.');
      if (operation.parentId && get(operation.parentId).deletedAt)
        throw new BadRequestException('Parent archivé.');
      block.parentId = operation.parentId;
      block.position = positionAfter(
        result.filter((b) => b.id !== block.id && b.parentId === block.parentId && !b.deletedAt),
        operation.afterId,
      );
    }
  }
  if (result.filter((b) => !b.deletedAt).length > 500)
    throw new BadRequestException('Maximum 500 blocs par page.');
  for (const block of result) {
    let current: BlockState | undefined = block;
    const seen = new Set<string>();
    while (current) {
      if (seen.has(current.id) || seen.size > 50)
        throw new BadRequestException('Cycle ou profondeur supérieure à 50.');
      if (!block.deletedAt && current.deletedAt) throw new BadRequestException('Parent archivé.');
      seen.add(current.id);
      current = current.parentId ? get(current.parentId) : undefined;
    }
    if (!block.deletedAt) {
      try {
        const validated = registry.validateWrite({
          id: block.id,
          parentId: block.parentId,
          position: block.position,
          type: block.type,
          schemaVersion: block.schemaVersion,
          content: block.content,
        });
        block.content = validated.content;
        block.schemaVersion = validated.schemaVersion;
      } catch {
        throw new BadRequestException('Contenu ou type de bloc non pris en charge.');
      }
    }
  }
  return result;
}
