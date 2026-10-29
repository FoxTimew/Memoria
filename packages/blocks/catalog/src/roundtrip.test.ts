import { describe, expect, it } from 'vitest';
import { BlockNoteEditor } from '@blocknote/core';
import { createEditorKit } from './client.ts';
import { blockModels, createBlockRegistry } from './server.ts';
import type { BlockEnvelope } from '@memoria/blocks-core';

const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const spans = [
  { type: 'text', text: 'Gras 👾\n', styles: { bold: true, italic: true } },
  {
    type: 'link',
    href: 'https://example.com/spec?a=1',
    content: [{ type: 'text', text: 'Lien', styles: { underline: true, strike: true } }],
  },
  { type: 'text', text: 'const x', styles: { code: true } },
];
function fixture(): BlockEnvelope[] {
  return blockModels.map((model, index) => ({
    id: id(index + 1),
    parentId: index === 2 ? id(2) : index === 3 ? id(3) : index === 4 ? id(3) : null,
    position: `a${index}`,
    type: model.type,
    schemaVersion: model.version,
    content: model.schema.parse({
      ...model.createDefault(),
      ...([
        'core.paragraph',
        'core.heading',
        'core.bullet-list-item',
        'core.numbered-list-item',
        'core.todo',
      ].includes(model.type)
        ? { spans }
        : {}),
      ...(model.type === 'core.heading' ? { level: 3 } : {}),
      ...(model.type === 'core.todo' ? { checked: true } : {}),
      ...(model.type === 'core.numbered-list-item' ? { start: 7 } : {}),
      ...(model.type === 'core.code'
        ? { language: 'typescript', code: 'const x = 1;\n\n  // café\n' }
        : {}),
      ...(model.type === 'core.image'
        ? { fileId: id(100), alt: 'Carte', caption: 'Étage 2', width: 640 }
        : {}),
      ...(model.type === 'core.file' ? { fileId: id(101), caption: 'Asset de scène' } : {}),
    }),
  }));
}
describe('actual BlockNote / ProseMirror roundtrip', () => {
  it('preserves every standard block as a nested child, including empty text and leaf blocks', async () => {
    const kit = await createEditorKit();
    const source = fixture().map((block, index) => ({ ...block, parentId: index ? id(1) : null }));
    source[0]!.content = { spans: [] };
    const editor = BlockNoteEditor.create({
      schema: kit.schema,
      initialContent: kit.toEditor(source),
    });
    try {
      const result = kit.fromEditor(editor.document);
      expect(result.map((block) => [block.id, block.parentId, block.content])).toEqual(
        source.map((block) => [block.id, block.parentId, block.content]),
      );
      expect(result.at(-1)?.afterId).toBe(source.at(-2)!.id);
    } finally {
      editor._tiptapEditor.destroy();
    }
  });
  it('preserves all standard models, character card, UUIDs, styles, links, nesting and sibling order', async () => {
    const kit = await createEditorKit();
    const source = fixture();
    const editor = BlockNoteEditor.create({
      schema: kit.schema,
      initialContent: kit.toEditor(source),
    });
    try {
      const converted = kit.fromEditor(editor.document);
      expect(
        converted.map(({ afterId, ...block }) => {
          void afterId;
          return block;
        }),
      ).toEqual(
        source.map(({ position, ...block }) => {
          void position;
          return block;
        }),
      );
      expect(converted.find((b) => b.id === id(5))?.afterId).toBe(id(4));
      const reload = converted.map(({ afterId, ...block }, index) => {
        void afterId;
        return { ...block, position: `a${index}` };
      });
      editor.replaceBlocks(editor.document, kit.toEditor(reload));
      expect(kit.fromEditor(editor.document)).toEqual(converted);
      expect(createBlockRegistry().get('core.code').toPlainText(source[5]!.content)).toContain(
        '// café',
      );
    } finally {
      editor._tiptapEditor.destroy();
    }
  });
  it('keeps UUID and descendants when a block changes type and moves', async () => {
    const kit = await createEditorKit();
    const editor = BlockNoteEditor.create({
      schema: kit.schema,
      initialContent: kit.toEditor(fixture()),
    });
    try {
      editor.updateBlock(id(2), { type: 'paragraph', props: {}, content: 'Titre converti' });
      const result = kit.fromEditor(editor.document);
      expect(result.find((b) => b.id === id(2))?.type).toBe('core.paragraph');
      expect(result.find((b) => b.id === id(3))?.parentId).toBe(id(2));
      const first = editor.document[0]!;
      editor.removeBlocks([first.id]);
      editor.insertBlocks([first], fixture().at(-1)!.id, 'after');
      expect(kit.fromEditor(editor.document).at(-1)?.id).toBe(first.id);
    } finally {
      editor._tiptapEditor.destroy();
    }
  });
  it('rejects unknown/future types, unsafe links, cycles and duplicate IDs without substituting content', async () => {
    const kit = await createEditorKit();
    const source = fixture();
    expect(() => kit.toEditor([{ ...source[0]!, type: 'future.widget' }])).toThrow('Unsupported');
    expect(() => kit.toEditor([{ ...source[0]!, schemaVersion: 99 }])).toThrow('Unsupported');
    expect(() => kit.toEditor([{ ...source[0]!, parentId: source[0]!.id }])).toThrow('cyclic');
    expect(() => kit.toEditor([source[0]!, source[0]!])).toThrow('Duplicate');
    expect(() =>
      kit.toEditor([
        {
          ...source[0]!,
          content: { spans: [{ type: 'link', href: 'javascript:alert(1)', content: [] }] },
        },
      ]),
    ).toThrow();
  });
});
