import { describe, expect, it } from 'vitest';
import { blockModels, createBlockRegistry } from '@memoria/block-catalog/server';
import { blockUis, createExampleEditorSchema } from '@memoria/block-catalog/client';

describe('catalog composition', () => {
  it('uses the same model instances in the independent server and client catalogs', () => {
    expect(blockUis.map((ui) => ui.model)).toEqual(blockModels);
    const registry = createBlockRegistry();
    for (const model of blockModels) {
      const content = model.createDefault();
      expect(registry.get(model.type).parse(content, model.version)).toEqual(content);
      expect(registry.get(model.type).toPlainText(content)).toBeDefined();
    }
  });

  it('still composes the native paragraph and lazily loaded character-card spec', async () => {
    const schema = await createExampleEditorSchema();
    expect(Object.keys(schema.blockSchema).sort()).toEqual(['gamedevCharacterCard', 'paragraph']);
  });
});
