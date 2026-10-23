import { BlockRegistry } from '@memoria/blocks-core';
import type { BlockModel, BlockData } from '@memoria/blocks-core';
import { characterCardModel } from '@memoria/block-character-card/model';
import { standardModels } from '@memoria/block-standard/model';

// Server composition root: only /model exports, never /ui or /client.
export const blockModels: readonly BlockModel<BlockData>[] = [
  ...standardModels,
  characterCardModel,
];

export function createBlockRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const model of blockModels) registry.register(model);
  return registry;
}
