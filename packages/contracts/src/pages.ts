import { z } from 'zod';
import { blockOperationSchema, blockSchema, pageCreateSchema, pageSchema } from './api.ts';
export const internalPageCreateSchema = pageCreateSchema;
export const pageSaveSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  title: z.string().max(500),
  operations: z.array(blockOperationSchema).max(1500),
});
export const pageMoveSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  parentId: z.uuid().nullable(),
  afterId: z.uuid().nullable(),
});
export const pageVersionInputSchema = z.strictObject({ expectedVersion: z.int().positive() });
export const pageDocumentSchema = z.strictObject({
  page: pageSchema,
  blocks: z.array(blockSchema.extend({ content: z.record(z.string(), z.json()) })).max(500),
});
export const pageTreeSchema = z.strictObject({
  pages: z.array(pageSchema),
  trash: z.array(pageSchema),
});
export const pageVersionSchema = z.strictObject({ version: z.int().positive() });
export const pageSaveResultSchema = z.strictObject({
  pageId: z.uuid(),
  version: z.int().positive(),
  changedBlockIds: z.array(z.uuid()),
});
export const searchResultsSchema = z.array(
  z.strictObject({ id: z.uuid(), title: z.string(), excerpt: z.string() }),
);
export type PageDocument = z.infer<typeof pageDocumentSchema>;
export type PageSummary = z.infer<typeof pageSchema>;
export type PageSave = z.infer<typeof pageSaveSchema>;
