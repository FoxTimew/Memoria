import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { characterCardUi, fromEditorProps, toEditorProps } from '@memoria/block-character-card/ui';

describe('character-card UI', () => {
  const model = characterCardUi.model;

  it('loads editor and readonly modules on demand and escapes user text', async () => {
    const editor = await characterCardUi.loadEditor();
    expect(editor.fromEditorProps(editor.toEditorProps(model.createDefault()))).toMatchObject({
      health: 100,
    });
    const { default: Readonly } = await characterCardUi.loadReadonly();
    const html = renderToStaticMarkup(
      createElement(Readonly, {
        data: { ...model.createDefault(), displayName: '<script>alert(1)</script>' },
      }),
    );
    expect(html).toContain('&lt;script&gt;');
    expect(html).not.toContain('<script>');
  });

  it('round-trips structured data through BlockNote primitive props', () => {
    const data = { ...model.createDefault(), displayName: 'Mira', tags: ['boss', 'forest'] };
    expect(fromEditorProps(toEditorProps(data))).toEqual(data);
    expect(model.toPlainText(data)).toContain('boss, forest');
  });
});
