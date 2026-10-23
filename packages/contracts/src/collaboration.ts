import { z } from 'zod';
import { blockOperationSchema } from './api.ts';
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
