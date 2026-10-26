import { z } from 'zod';
export const shareUpdateSchema = z.strictObject({
  expectedAccessVersion: z.int().positive(),
  level: z.enum(['read', 'edit']).nullable(),
});
export const pageSharesSchema = z.strictObject({
  accessVersion: z.int().positive(),
  guests: z.array(
    z.strictObject({
      memberId: z.uuid(),
      name: z.string(),
      level: z.enum(['read', 'edit']).nullable(),
      direct: z.enum(['read', 'edit']).nullable(),
      sources: z.array(
        z.strictObject({ pageId: z.uuid(), title: z.string(), level: z.enum(['read', 'edit']) }),
      ),
    }),
  ),
});
export const accessPreviewSchema = z.strictObject({
  token: z.string(),
  accessVersion: z.int().positive(),
  pages: z.int(),
  effects: z.array(
    z.strictObject({
      memberId: z.uuid(),
      name: z.string(),
      changes: z.array(
        z.strictObject({
          from: z.enum(['none', 'read', 'edit']),
          to: z.enum(['none', 'read', 'edit']),
          count: z.int().positive(),
        }),
      ),
    }),
  ),
});
export type AccessPreview = z.infer<typeof accessPreviewSchema>;
export const shareDraftSchema = z.object({
  page: z.uuid(),
  member: z.uuid(),
  level: z.enum(['read', 'edit', 'none']),
});
export type ShareDraft = z.infer<typeof shareDraftSchema>;
