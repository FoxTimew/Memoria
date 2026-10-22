import { randomUUID } from 'node:crypto';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { BlockRegistry } from '@memoria/blocks-core';
import { fromEditorProps, toEditorProps } from './adapter.ts';
import { characterCard } from './index.ts';

describe('character-card contract', () => {
  const registry = new BlockRegistry().register(characterCard);
  it('loads editor and readonly modules on demand and escapes user text', async () => {
    const editor = await characterCard.loadEditor();
    expect(
      editor.fromEditorProps(editor.toEditorProps(characterCard.createDefault())),
    ).toMatchObject({ health: 100 });
    const { default: Readonly } = await characterCard.loadReadonly();
    const html = renderToStaticMarkup(
      createElement(Readonly, {
        data: { ...characterCard.createDefault(), displayName: '<script>alert(1)</script>' },
      }),
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });
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
  it('round-trips structured data through BlockNote primitive props', () => {
    const data = {
      ...characterCard.createDefault(),
      displayName: 'Mira',
      tags: ['boss', 'forest'],
    };
    expect(fromEditorProps(toEditorProps(data))).toEqual(data);
    expect(characterCard.toPlainText(data)).toContain('boss, forest');
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
