import { randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { BlockRegistry } from '@memoria/blocks-core';
import { characterCardModel as characterCard } from '@memoria/block-character-card/model';

describe('character-card contract', () => {
  const registry = new BlockRegistry().register(characterCard);
  it('upgrades v1 without changing the engine ID or mutating the source', () => {
    const old = Object.freeze({
      characterId: randomUUID(),
      name: 'Mira',
      description: 'Forest guardian',
    });
    const result = registry.validateWrite({
      id: randomUUID(),
      parentId: null,
      position: 'a0',
      type: characterCard.type,
      schemaVersion: 1,
      content: old,
    });
    expect(result.schemaVersion).toBe(2);
    expect(result.content).toMatchObject({
      characterId: old.characterId,
      displayName: 'Mira',
      health: 100,
    });
    expect(old).toHaveProperty('name', 'Mira');
  });
  it('rejects unknown types, future versions, invalid data and duplicate registration', () => {
    expect(() => registry.get('unknown.block')).toThrow('Unknown');
    expect(() => registry.get(characterCard.type).parse({}, 3)).toThrow('Unsupported');
    expect(() =>
      registry.get(characterCard.type).parse({ ...characterCard.createDefault(), health: -1 }, 2),
    ).toThrow();
    expect(() => registry.register(characterCard)).toThrow('Duplicate');
  });
});
