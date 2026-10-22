import { z } from 'zod';

export const createWorkspaceSchema = z.strictObject({
  name: z.string().trim().min(1).max(100),
  slug: z
    .string()
    .min(3)
    .max(63)
    .regex(/^[a-z0-9]+(?:-[a-z0-9]+)*$/),
});
export const workspaceSummarySchema = z.strictObject({
  id: z.uuid(),
  name: z.string(),
  slug: z.string(),
  role: z.enum(['owner', 'admin', 'member', 'guest']),
});
export const workspaceListSchema = z.array(workspaceSummarySchema);
export type WorkspaceSummary = z.infer<typeof workspaceSummarySchema>;
