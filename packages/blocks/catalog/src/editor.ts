import {
  BlockNoteSchema,
  defaultBlockSpecs,
  insertOrUpdateBlockForSlashMenu,
} from '@blocknote/core';
import { blockDefinitions } from './index.ts';

/** Load block specs before creating the editor; never mutate a live PM schema. */
export async function createExampleEditorSchema() {
  // Keep the concrete spec type in this example's composition root.
  const adapter = await blockDefinitions[0].loadEditor();
  return BlockNoteSchema.create({
    blockSpecs: { paragraph: defaultBlockSpecs.paragraph, [adapter.editorType]: adapter.spec },
  });
}

type ExampleEditor = Awaited<ReturnType<typeof createExampleEditorSchema>>['BlockNoteEditor'];

/** Pass these items to BlockNote's SuggestionMenuController; map icon keys in the UI. */
export async function createExampleSlashItems(editor: ExampleEditor) {
  return Promise.all(
    blockDefinitions.map(async (definition) => {
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
            props: adapter.toEditorProps(definition.createDefault()),
          }),
      };
    }),
  );
}
