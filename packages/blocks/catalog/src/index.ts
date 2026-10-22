import { BlockRegistry } from '@memoria/blocks-core';
import { characterCard } from '@memoria/block-character-card';

// Composition root: adding a plugin changes this manifest, never blocks-core.
export const blockDefinitions = [characterCard] as const;
export function createBlockRegistry(): BlockRegistry {
  const registry = new BlockRegistry();
  for (const definition of blockDefinitions) registry.register(definition);
  return registry;
}
