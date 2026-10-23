'use client';
import { defaultBlockSpecs, createHeadingBlockSpec } from '@blocknote/core';
import type { BlockSpec } from '@blocknote/core';
import { createReactBlockSpec } from '@blocknote/react';
import type { BlockEditorModule, EditorProps } from '@memoria/blocks-ui';
import type { BlockData } from '@memoria/blocks-core';
import { standardModels, imageSchema, spansSchema } from './model.ts';

// A durable file ID, never an expiring URL. File delivery is implemented in session 6.
export const imageSpec = createReactBlockSpec(
  {
    type: 'memoriaImage',
    content: 'none',
    propSchema: {
      fileId: { default: '' },
      alt: { default: '' },
      caption: { default: '' },
      width: { default: 512 },
    },
  },
  {
    render: ({ block, editor }) => (
      <figure contentEditable={false} aria-label="Image">
        <div>Emplacement d’image · import de fichiers à venir</div>
        <label>
          Texte alternatif{' '}
          <input
            aria-label="Texte alternatif de l’image"
            maxLength={1000}
            value={block.props.alt}
            disabled={!editor.isEditable}
            onChange={(e) => editor.updateBlock(block, { props: { alt: e.target.value } })}
          />
        </label>
        <label>
          Légende{' '}
          <input
            aria-label="Légende de l’image"
            maxLength={2000}
            value={block.props.caption}
            disabled={!editor.isEditable}
            onChange={(e) => editor.updateBlock(block, { props: { caption: e.target.value } })}
          />
        </label>
        <label>
          Largeur{' '}
          <input
            aria-label="Largeur de l’image"
            type="number"
            min={32}
            max={4096}
            value={block.props.width}
            disabled={!editor.isEditable}
            onChange={(e) => {
              const width = e.target.valueAsNumber;
              if (Number.isInteger(width) && width >= 32 && width <= 4096)
                editor.updateBlock(block, { props: { width } });
            }}
          />
        </label>
      </figure>
    ),
  },
)();
const entries = [
  ['paragraph', defaultBlockSpecs.paragraph],
  ['heading', createHeadingBlockSpec({ levels: [1, 2, 3] })],
  ['bulletListItem', defaultBlockSpecs.bulletListItem],
  ['numberedListItem', defaultBlockSpecs.numberedListItem],
  ['checkListItem', defaultBlockSpecs.checkListItem],
  ['codeBlock', defaultBlockSpecs.codeBlock],
  ['memoriaImage', imageSpec],
  ['divider', defaultBlockSpecs.divider],
] as const;

const heading = createHeadingBlockSpec({ levels: [1, 2, 3] });
// isToggleable is absent at runtime for this configuration; exclude its optional upstream type.
const { isToggleable: _toggle, ...headingProps } = heading.config.propSchema;
void _toggle;
void headingProps;
export const standardSpecs = {
  paragraph: defaultBlockSpecs.paragraph,
  heading: heading as unknown as BlockSpec<'heading', typeof headingProps, 'inline'>,
  bulletListItem: defaultBlockSpecs.bulletListItem,
  numberedListItem: defaultBlockSpecs.numberedListItem,
  checkListItem: defaultBlockSpecs.checkListItem,
  codeBlock: defaultBlockSpecs.codeBlock,
  memoriaImage: imageSpec,
  divider: defaultBlockSpecs.divider,
};

export const standardAdapters: BlockEditorModule<BlockData>[] = standardModels.map(
  (model, index) => {
    const [editorType, spec] = entries[index]!;
    const from = (props: Record<string, string | number | boolean>, content: unknown) => {
      if (editorType === 'memoriaImage')
        return imageSchema.parse({
          fileId: props.fileId || null,
          alt: props.alt,
          caption: props.caption,
          width: props.width,
        });
      if (editorType === 'divider') return {};
      if (editorType === 'codeBlock') {
        // BlockNote 0.56 exposes plain content as styled text without marks.
        const spans = spansSchema.parse(content ?? []);
        if (spans.some((s) => s.type !== 'text' || Object.keys(s.styles).length))
          throw new Error('Styled code is unsupported');
        return model.schema.parse({
          language: props.language,
          code: spans.map((s) => (s.type === 'text' ? s.text : '')).join(''),
        });
      }
      return model.schema.parse({
        spans: content ?? [],
        ...(editorType === 'heading' ? { level: props.level } : {}),
        ...(editorType === 'checkListItem' ? { checked: props.checked } : {}),
        ...(editorType === 'numberedListItem' ? { start: props.start ?? null } : {}),
      });
    };
    return {
      // Heading's upstream optional prop typing is incompatible with exactOptionalPropertyTypes.
      editorType,
      spec: spec as BlockEditorModule<BlockData>['spec'],
      toEditorProps(data): EditorProps {
        const value: BlockData = model.schema.parse(data);
        if (editorType === 'memoriaImage') {
          const image = imageSchema.parse(value);
          return { ...image, fileId: image.fileId ?? '' };
        }
        if (editorType === 'heading') return { level: Number(value.level) };
        if (editorType === 'checkListItem') return { checked: Boolean(value.checked) };
        if (editorType === 'codeBlock') return { language: String(value.language) };
        if (editorType === 'numberedListItem' && value.start !== null)
          return { start: Number(value.start) };
        return {};
      },
      fromEditorProps: (props) => from(props, []),
      toEditorContent(data) {
        const value: BlockData = model.schema.parse(data);
        return editorType === 'codeBlock'
          ? [{ type: 'text', text: value.code, styles: {} }]
          : value.spans;
      },
      fromEditorContent: from,
    };
  },
);
