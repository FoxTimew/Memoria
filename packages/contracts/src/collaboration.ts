import { z } from 'zod';
import { blockOperationSchema } from './api.ts';
export const collaborationOpenSchema = z.strictObject({
  generation: z.uuid(),
  contentRevision: z.int().nonnegative(),
  projectionRevision: z.int().nonnegative(),
  room: z.string().max(160),
});
export const collaborationSessionSchema = z.strictObject({ user: z.uuid(), session: z.uuid() });
export const collaborationClientTokenSchema = collaborationSessionSchema.extend({
  scope: z.literal('page'),
  accessVersion: z.int().positive(),
});
/** Fresh HTTP identity, bound again to the cookie on WebSocket authentication. */
export const collaborationAccessSchema = collaborationOpenSchema.extend({
  identity: collaborationSessionSchema,
  level: z.enum(['read', 'edit']),
  accessVersion: z.int().positive(),
});
export const collaborationWriteSchema = z.strictObject({
  generation: z.uuid(),
  expectedRevision: z.int().nonnegative(),
  receipt: z.uuid(),
  operations: z
    .array(blockOperationSchema)
    .min(1)
    .max(500)
    .refine(
      (ops) => ops.every((op) => op.op !== 'restore'),
      'Block restoration uses editor undo; no JSON restore across CRDT generations',
    ),
});
const identity = { user: z.uuid(), session: z.uuid(), workspace: z.uuid(), page: z.uuid() };
export const collaborationCommandSchema = z.discriminatedUnion('action', [
  z.strictObject({ action: z.literal('open'), ...identity }),
  z.strictObject({ action: z.literal('write'), ...identity, ...collaborationWriteSchema.shape }),
]);
export type CollaborationWrite = z.infer<typeof collaborationWriteSchema>;
export type CollaborationCommand = z.infer<typeof collaborationCommandSchema>;
