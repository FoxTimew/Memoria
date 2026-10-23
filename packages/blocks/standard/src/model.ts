import { z } from 'zod';
import type { BlockData, BlockModel, BlockType } from '@memoria/blocks-core';

export const stylesSchema = z
  .strictObject({
    bold: z.literal(true).optional(),
    italic: z.literal(true).optional(),
    underline: z.literal(true).optional(),
    strike: z.literal(true).optional(),
    code: z.literal(true).optional(),
  })
  .transform((styles): Record<string, true> =>
    Object.fromEntries(
      Object.entries(styles).filter((entry): entry is [string, true] => entry[1] === true),
    ),
  );
export const textSpanSchema = z.strictObject({
  type: z.literal('text'),
  text: z.string().max(20000),
  styles: stylesSchema,
});
export const spansSchema = z
  .array(
    z.discriminatedUnion('type', [
      textSpanSchema,
      z.strictObject({
        type: z.literal('link'),
        href: z.url({ protocol: /^https?$/ }).max(2048),
        content: z.array(textSpanSchema).max(1000),
      }),
    ]),
  )
  .max(1000);
export type Spans = z.infer<typeof spansSchema>;

/** ProseMirror merges adjacent runs with identical marks. Store that canonical form. */
export function normalizeSpans(input: Spans): Spans {
  const texts = (runs: z.infer<typeof textSpanSchema>[]) => {
    const result: z.infer<typeof textSpanSchema>[] = [];
    for (const run of runs) {
      if (!run.text) continue;
      const previous = result.at(-1);
      const keys = (styles: z.infer<typeof stylesSchema>) => Object.keys(styles).sort().join(',');
      if (previous && keys(previous.styles) === keys(run.styles)) previous.text += run.text;
      else result.push(structuredClone(run));
    }
    return result;
  };
  const result: Spans = [];
  for (const span of input) {
    const previous = result.at(-1);
    if (span.type === 'text') {
      if (!span.text) continue;
      if (previous?.type === 'text') result.splice(-1, 1, ...texts([previous, span]));
      else result.push(structuredClone(span));
    } else {
      const content = texts(span.content);
      if (!content.length) continue;
      if (previous?.type === 'link' && previous.href === span.href)
        previous.content = texts([...previous.content, ...content]);
      else result.push({ ...span, content });
    }
  }
  return result;
}
const spans = spansSchema.transform(normalizeSpans);
export const paragraphSchema = z.strictObject({ spans });
export const numberedSchema = z.strictObject({
  spans,
  start: z.int().min(1).max(1000000).nullable(),
});
export const headingSchema = z.strictObject({
  level: z.union([z.literal(1), z.literal(2), z.literal(3)]),
  spans,
});
export const todoSchema = z.strictObject({ checked: z.boolean(), spans });
export const codeSchema = z.strictObject({
  language: z.string().regex(/^[\w+-]{1,40}$/),
  code: z.string().max(100000),
});
export const imageSchema = z.strictObject({
  fileId: z.uuid().nullable(),
  alt: z.string().max(1000),
  caption: z.string().max(2000),
  width: z.int().min(32).max(4096),
});
export const dividerSchema = z.strictObject({});
export function spansToText(value: Spans) {
  return value
    .map((span) => (span.type === 'text' ? span.text : span.content.map((s) => s.text).join('')))
    .join('');
}
function model<Data extends BlockData>(
  type: BlockType,
  schema: z.ZodType<Data>,
  defaults: Data,
  text: (data: Data) => string,
): BlockModel<Data> {
  return {
    type,
    version: 1,
    schema,
    createDefault: () => structuredClone(defaults),
    migrate(data, version) {
      if (version !== 1) throw new Error(`Unsupported ${type} version ${version}`);
      return schema.parse(data);
    },
    toPlainText: text,
  };
}
export const paragraphModel = model('core.paragraph', paragraphSchema, { spans: [] }, (d) =>
  spansToText(d.spans),
);
export const headingModel = model('core.heading', headingSchema, { level: 1, spans: [] }, (d) =>
  spansToText(d.spans),
);
export const bulletModel = model('core.bullet-list-item', paragraphSchema, { spans: [] }, (d) =>
  spansToText(d.spans),
);
export const numberedModel = model(
  'core.numbered-list-item',
  numberedSchema,
  { spans: [], start: null },
  (d) => spansToText(d.spans),
);
export const todoModel = model('core.todo', todoSchema, { checked: false, spans: [] }, (d) =>
  spansToText(d.spans),
);
export const codeModel = model(
  'core.code',
  codeSchema,
  { language: 'text', code: '' },
  (d) => d.code,
);
export const imageModel = model(
  'core.image',
  imageSchema,
  { fileId: null, alt: '', caption: '', width: 512 },
  (d) => `${d.alt}\n${d.caption}`,
);
export const dividerModel = model('core.divider', dividerSchema, {}, () => '');
export const standardModels = [
  paragraphModel,
  headingModel,
  bulletModel,
  numberedModel,
  todoModel,
  codeModel,
  imageModel,
  dividerModel,
] as const;
