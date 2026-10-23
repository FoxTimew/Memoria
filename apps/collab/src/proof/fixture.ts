// Test input generator only. Never imported by the server codec or journal.
import {
  BlockNoteEditor,
  BlockNoteSchema,
  createBlockSpec,
  defaultStyleSpecs,
} from '@blocknote/core';
import { blocksToYDoc } from '@blocknote/core/yjs';
import type { PartialBlock } from '@blocknote/core';
import { loadStandardSpecs } from '../../../../packages/blocks/standard/src/ui.ts';

export const fixtureId = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;

export async function representativeDocument(count = 300) {
  // Field props are separate Y.XmlElement attributes, not one JSON blob.
  // This headless spec deliberately has no interactive rendering.
  const card = createBlockSpec(
    {
      type: 'gamedevCharacterCard',
      content: 'none',
      propSchema: {
        schemaVersion: { default: 2 },
        characterId: { default: '' },
        displayName: { default: '' },
        archetype: { default: 'npc' },
        biography: { default: '' },
        health: { default: 100 },
        attack: { default: 10 },
        tags: { default: '[]' },
      },
    },
    {
      render: () => {
        throw new Error('Headless proof: rendering is forbidden');
      },
    },
  )();
  const schema = BlockNoteSchema.create({
    blockSpecs: { ...(await loadStandardSpecs()), gamedevCharacterCard: card },
    styleSpecs: {
      bold: defaultStyleSpecs.bold,
      italic: defaultStyleSpecs.italic,
      underline: defaultStyleSpecs.underline,
      strike: defaultStyleSpecs.strike,
      code: defaultStyleSpecs.code,
    },
  });
  type Input = PartialBlock<
    typeof schema.blockSchema,
    typeof schema.inlineContentSchema,
    typeof schema.styleSchema
  >;
  const roots: Input[] = [];
  let parent = roots;
  for (let i = 0; i < count; i++) {
    const text = `Bloc ${i} — conception du monde et objectifs 👾. `.repeat(8);
    const content = [
      { type: 'text' as const, text, styles: { bold: true as const } },
      {
        type: 'link' as const,
        href: 'https://example.com/design',
        content: [{ type: 'text' as const, text: 'Référence', styles: { italic: true as const } }],
      },
    ];
    const types = [
      'paragraph',
      'heading',
      'bulletListItem',
      'numberedListItem',
      'checkListItem',
      'codeBlock',
      'memoriaImage',
      'divider',
      'gamedevCharacterCard',
    ] as const;
    const type = types[i % types.length]!;
    const block: Input = {
      id: fixtureId(i + 1),
      type,
      ...(type === 'gamedevCharacterCard'
        ? {
            props: {
              schemaVersion: 2,
              characterId: fixtureId(1000 + i),
              displayName: `Personnage ${i}`,
              biography: text,
              health: 100,
              attack: 10,
              archetype: 'npc',
              tags: '["studio","quête"]',
            },
          }
        : type === 'codeBlock'
          ? { props: { language: 'typescript' }, content: 'const score = 42;\n// café\n' }
          : type === 'memoriaImage'
            ? { props: { fileId: '', alt: 'Carte', caption: 'Niveau', width: 640 } }
            : type === 'divider'
              ? {}
              : { content, ...(type === 'heading' ? { props: { level: 2 } } : {}) }),
      children: [],
    } as Input;
    // Every 10 blocks: root, 4 children, grandchild and 4 siblings (depth 3).
    if (i % 10 === 0) parent = roots;
    parent.push(block);
    if (i % 10 === 0 || i % 10 === 4) parent = block.children!;
  }
  const editor = BlockNoteEditor.create({ schema, initialContent: roots });
  try {
    return {
      doc: blocksToYDoc(editor, editor.document),
      json: editor._tiptapEditor.state.doc.toJSON() as unknown,
    };
  } finally {
    editor._tiptapEditor.destroy();
  }
}
