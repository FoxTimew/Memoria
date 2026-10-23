'use client';

import {
  BlockNoteSchema,
  defaultBlockSpecs,
  defaultStyleSpecs,
  insertOrUpdateBlockForSlashMenu,
} from '@blocknote/core';
import { characterCardUi } from '@memoria/block-character-card/ui';
import { standardUis, loadStandardSpecs } from '@memoria/block-standard/ui';
import type { BlockData, BlockEnvelope } from '@memoria/blocks-core';
import { blockEnvelopeSchema } from '@memoria/blocks-core';
import type { BlockEditorModule, EditorProps } from '@memoria/blocks-ui';
import type { PartialBlock } from '@blocknote/core';

export const blockUis = [...standardUis, characterCardUi] as const;

/** Load block specs before creating the editor; never mutate a live PM schema. */
export async function createExampleEditorSchema() {
  // Keep the concrete spec type in this example's composition root.
  const adapter = await characterCardUi.loadEditor();
  return BlockNoteSchema.create({
    blockSpecs: { paragraph: defaultBlockSpecs.paragraph, [adapter.editorType]: adapter.spec },
  });
}

export type DraftBlock = Omit<BlockEnvelope, 'position'> & { afterId: string | null };

/** Composition stays client-side. Runtime shapes are validated before crossing this boundary. */
export async function createEditorKit() {
  const adapters = await Promise.all(
    blockUis.map(async (ui) => ({
      ui,
      adapter: (await ui.loadEditor()) as BlockEditorModule<BlockData>,
    })),
  );
  const byModel = new Map(adapters.map((item) => [item.ui.model.type as string, item]));
  const byEditor = new Map(adapters.map((item) => [item.adapter.editorType, item]));
  const schema = BlockNoteSchema.create({
    blockSpecs: {
      ...(await loadStandardSpecs()),
      gamedevCharacterCard: (await characterCardUi.loadEditor()).spec,
    },
    styleSpecs: {
      bold: defaultStyleSpecs.bold,
      italic: defaultStyleSpecs.italic,
      underline: defaultStyleSpecs.underline,
      strike: defaultStyleSpecs.strike,
      code: defaultStyleSpecs.code,
    },
  });
  type InputBlock = PartialBlock<
    typeof schema.blockSchema,
    typeof schema.inlineContentSchema,
    typeof schema.styleSchema
  >;
  type OutputBlock = typeof schema.Block;
  function encoded(adapter: BlockEditorModule<BlockData>, data: BlockData) {
    const content = adapter.toEditorContent?.(data);
    // This is the sole structural cast to BlockNote. Every value is model-validated above it.
    return {
      props: adapter.toEditorProps(data),
      ...(content === undefined ? {} : { content }),
    } as unknown as InputBlock;
  }
  function toEditor(input: readonly BlockEnvelope[]): InputBlock[] {
    if (input.length > 500) throw new Error('Maximum 500 blocks');
    const blocks = input.map((block) => blockEnvelopeSchema.parse(block));
    if (new Set(blocks.map((b) => b.id)).size !== blocks.length)
      throw new Error('Duplicate block ID');
    const visited = new Set<string>();
    function children(parentId: string | null, depth: number): InputBlock[] {
      if (depth > 50) throw new Error('Maximum nesting depth 50');
      return blocks
        .filter((block) => block.parentId === parentId)
        .sort((a, b) => (a.position < b.position ? -1 : a.position > b.position ? 1 : 0))
        .map((block) => {
          if (visited.has(block.id)) throw new Error('Block cycle');
          visited.add(block.id);
          const entry = byModel.get(block.type);
          if (!entry) throw new Error(`Unsupported block preserved: ${block.type}`);
          const data = entry.ui.model.migrate(block.content, block.schemaVersion);
          return {
            ...encoded(entry.adapter, data),
            id: block.id,
            type: entry.adapter.editorType,
            children: children(block.id, depth + 1),
          } as InputBlock;
        });
    }
    const result = children(null, 0);
    if (visited.size !== blocks.length) throw new Error('Orphan or cyclic blocks');
    return result;
  }
  function fromEditor(input: readonly OutputBlock[]): DraftBlock[] {
    const result: DraftBlock[] = [];
    const ids = new Set<string>();
    function visit(blocks: readonly OutputBlock[], parentId: string | null, depth: number) {
      if (depth > 50) throw new Error('Maximum nesting depth 50');
      let afterId: string | null = null;
      for (const block of blocks) {
        if (ids.has(block.id)) throw new Error('Duplicate block ID');
        ids.add(block.id);
        if (ids.size > 500) throw new Error('Maximum 500 blocks');
        const entry = byEditor.get(block.type);
        if (!entry) throw new Error(`Unsupported editor block: ${block.type}`);
        const props = block.props as EditorProps;
        // Do not silently discard unsupported native formatting.
        for (const key of ['textColor', 'backgroundColor'])
          if (props[key] && props[key] !== 'default') throw new Error('Unsupported color');
        if (props.textAlignment && props.textAlignment !== 'left')
          throw new Error('Unsupported alignment');
        const data = entry.adapter.fromEditorContent
          ? entry.adapter.fromEditorContent(props, block.content)
          : entry.adapter.fromEditorProps(props);
        const parsed = blockEnvelopeSchema.parse({
          id: block.id,
          parentId,
          position: 'a0',
          type: entry.ui.model.type,
          schemaVersion: entry.ui.model.version,
          content: entry.ui.model.schema.parse(data),
        });
        const { position: _position, ...envelope } = parsed;
        void _position;
        result.push({ ...envelope, afterId });
        visit(block.children, block.id, depth + 1);
        afterId = block.id;
      }
    }
    visit(input, null, 0);
    return result;
  }
  return { schema, toEditor, fromEditor, adapters };
}

type ExampleEditor = Awaited<ReturnType<typeof createExampleEditorSchema>>['BlockNoteEditor'];

/** Pass these items to BlockNote's SuggestionMenuController; map icon keys in the UI. */
export async function createExampleSlashItems(editor: ExampleEditor) {
  return Promise.all(
    [characterCardUi].map(async (definition) => {
      const adapter = await definition.loadEditor();
      return {
        title: definition.menu.label,
        group: definition.menu.category,
        aliases: [...definition.menu.keywords],
        iconKey: definition.menu.icon,
        onItemClick: () =>
          insertOrUpdateBlockForSlashMenu<
            ExampleEditor['schema']['blockSchema'],
            ExampleEditor['schema']['inlineContentSchema'],
            ExampleEditor['schema']['styleSchema']
          >(editor, {
            type: adapter.editorType,
            props: adapter.toEditorProps(definition.model.createDefault()),
          }),
      };
    }),
  );
}
