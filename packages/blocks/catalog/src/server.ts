import { BlockRegistry } from '@memoria/blocks-core';
import { characterCardModel } from '@memoria/block-character-card/model';

// Server composition root: only /model exports, never /ui or /client.
export const blockModels = [characterCardModel] as const;

export function createBlockRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const model of blockModels) registry.register(model);
  return registry;
}
