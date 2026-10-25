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

export const workspaceSecurityUpdateSchema = z.strictObject({
  expectedVersion: z.int().positive(),
  requireStrongAuth: z.boolean(),
  graceDays: z.int().min(0).max(30),
  allowPersistentCache: z.boolean().optional(),
});
export const workspaceRoleUpdateSchema = z.strictObject({
  expectedRole: z.enum(['owner', 'member']),
  role: z.enum(['owner', 'member']),
});
export const workspaceSecuritySchema = z.strictObject({
  requireStrongAuth: z.boolean(),
  graceDays: z.int(),
  version: z.int(),
  enabledAt: z.string().nullable(),
  deadline: z.string().nullable(),
  role: z.enum(['owner', 'member']),
  contentAllowed: z.boolean(),
  recentStrong: z.boolean(),
  allowPersistentCache: z.boolean(),
});
export type WorkspaceSecurity = z.infer<typeof workspaceSecuritySchema>;
export const cachePolicySchema = z.strictObject({
  user: z.uuid(),
  session: z.uuid(),
  sharedComputer: z.boolean(),
  workspaces: z.array(
    z.strictObject({ workspace: z.uuid(), version: z.int().positive(), allowed: z.boolean() }),
  ),
});
export const workspaceMembersSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    name: z.string(),
    role: z.enum(['owner', 'member', 'admin', 'guest']),
    deadline: z.string().nullable(),
  }),
);
