import { z } from 'zod';

export const scopeSchema = z.enum([
  'pages:read',
  'pages:write',
  'databases:read',
  'databases:write',
  'files:read',
  'files:write',
  'search:read',
]);
export const roleSchema = z.enum(['owner', 'admin', 'member', 'guest']);
type ContextBase = Readonly<{ workspaceId: string; actorId: string; requestId: string }>;
export type RequestContext = ContextBase &
  Readonly<{
    principal:
      | { kind: 'member'; memberId: string; role: z.infer<typeof roleSchema> }
      | {
          kind: 'api_key';
          apiKeyId: string;
          issuerMemberId: string;
          role: z.infer<typeof roleSchema>;
          scopes: readonly z.infer<typeof scopeSchema>[];
        };
  }>;
/** Created only by trusted job handlers, never from HTTP input. */
export type SystemContext = ContextBase &
  Readonly<{ principal: { kind: 'system'; jobId: string; purpose: 'retention' | 'migration' } }>;

export const apiErrorSchema = z.strictObject({
  error: z.strictObject({
    code: z.string(),
    message: z.string(),
    requestId: z.string(),
    details: z.array(z.strictObject({ path: z.string(), message: z.string() })).optional(),
  }),
});
export const paginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().max(4096).optional(),
});
export const pageSchema = z.strictObject({
  level: z.enum(['read', 'edit']).optional(),
  id: z.uuid(),
  workspaceId: z.uuid(),
  parentId: z.uuid().nullable(),
  title: z.string().max(500),
  position: z.string().max(128),
  version: z.int().positive(),
  createdAt: z.iso.datetime({ offset: true }),
  updatedAt: z.iso.datetime({ offset: true }),
  deletedAt: z.iso.datetime({ offset: true }).nullable(),
});
export const pageCreateSchema = z.strictObject({
  parentId: z.uuid().nullable(),
  title: z.string().max(500),
  afterId: z.uuid().nullable().optional(),
});
export const pagePatchSchema = z.strictObject({
  title: z.string().max(500).optional(),
  parentId: z.uuid().nullable().optional(),
  afterId: z.uuid().nullable().optional(),
});

export const blockSchema = z.strictObject({
  id: z.uuid(),
  parentId: z.uuid().nullable(),
  position: z
    .string()
    .regex(/^[0-9A-Za-z]+$/)
    .max(128),
  type: z.string().regex(/^[a-z][a-z0-9-]*\.[a-z][a-z0-9-]*$/),
  schemaVersion: z.int().positive(),
  content: z.record(z.string(), z.unknown()),
});
const placement = { parentId: z.uuid().nullable(), afterId: z.uuid().nullable() };
export const blockOperationSchema = z.discriminatedUnion('op', [
  z.strictObject({
    op: z.literal('insert'),
    id: z.uuid(),
    ...placement,
    type: blockSchema.shape.type,
    schemaVersion: z.int().positive(),
    content: blockSchema.shape.content,
  }),
  z.strictObject({
    op: z.literal('update'),
    id: z.uuid(),
    type: blockSchema.shape.type.optional(),
    schemaVersion: z.int().positive(),
    content: blockSchema.shape.content,
  }),
  z.strictObject({ op: z.literal('move'), id: z.uuid(), ...placement }),
  z.strictObject({ op: z.literal('archive'), id: z.uuid() }),
  z.strictObject({
    op: z.literal('restore'),
    id: z.uuid(),
    ...placement,
    withDescendants: z.boolean().optional(),
  }),
]);
export const blockBatchSchema = z.strictObject({
  operations: z.array(blockOperationSchema).min(1).max(500),
});
export type BlockBatch = z.infer<typeof blockBatchSchema>;

export function pageETag(id: string, version: number): string {
  z.uuid().parse(id);
  z.int().positive().parse(version);
  return `"page-${id}-v${version}"`;
}
export function expectedPageVersion(ifMatch: string, pageId: string): number {
  const match = /^"page-([0-9a-f-]{36})-v([1-9][0-9]*)"$/.exec(ifMatch);
  if (!match || match[1] !== pageId)
    throw new Error('Invalid page If-Match: a single strong page ETag is required');
  return z.int().positive().parse(Number(match[2]));
}

export const propertyValueSchema = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('text'), value: z.string().max(10000).nullable() }),
  z.strictObject({
    type: z.literal('number'),
    value: z
      .string()
      .regex(/^-?\d{1,20}(\.\d{1,8})?$/)
      .nullable(),
  }),
  z.strictObject({ type: z.literal('select'), value: z.uuid().nullable() }),
  z.strictObject({ type: z.literal('multi_select'), value: z.array(z.uuid()).max(100) }),
  z.strictObject({ type: z.literal('checkbox'), value: z.boolean().nullable() }),
  z.strictObject({ type: z.literal('person'), value: z.array(z.uuid()).max(50) }),
  z.strictObject({ type: z.literal('relation'), value: z.array(z.uuid()).max(1000) }),
  z.strictObject({ type: z.literal('url'), value: z.url({ protocol: /^https?$/ }).nullable() }),
  z.strictObject({
    type: z.literal('date'),
    value: z
      .union([
        z.strictObject({
          kind: z.literal('date'),
          start: z.iso.date(),
          end: z.iso.date().nullable(),
        }),
        z.strictObject({
          kind: z.literal('datetime'),
          start: z.iso.datetime({ offset: true }),
          end: z.iso.datetime({ offset: true }).nullable(),
          timeZone: z.string().max(100),
        }),
      ])
      .nullable(),
  }),
]);
export const rowValuesSchema = z.record(z.uuid(), propertyValueSchema);
export const domainEventSchema = z.strictObject({
  id: z.uuid(),
  workspaceId: z.uuid(),
  type: z.enum([
    'page.created',
    'page.updated',
    'block.updated',
    'database.row.created',
    'database.row.updated',
  ]),
  schemaVersion: z.literal(1),
  occurredAt: z.iso.datetime({ offset: true }),
  data: z.strictObject({
    pageId: z.uuid(),
    pageVersion: z.int().positive(),
    blockId: z.uuid().optional(),
    databaseId: z.uuid().optional(),
  }),
});
