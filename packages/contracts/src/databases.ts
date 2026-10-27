import { z } from 'zod';

const field = z.union([z.literal('title'), z.uuid()]);
export const databaseQuerySchema = z
  .object({
    filters: z
      .array(
        z
          .object({
            field,
            op: z.enum([
              'eq',
              'ne',
              'lt',
              'lte',
              'gt',
              'gte',
              'between',
              'contains',
              'startsWith',
              'in',
              'any',
              'empty',
              'notEmpty',
            ]),
            value: z.unknown().optional(),
          })
          .strict(),
      )
      .default([]),
    sorts: z.array(z.object({ field, direction: z.enum(['asc', 'desc']) }).strict()).default([]),
    pageSize: z.number().int().positive().optional(),
    cursor: z.string().max(16384).optional(),
  })
  .strict();
export type DatabaseQuery = z.infer<typeof databaseQuerySchema>;
