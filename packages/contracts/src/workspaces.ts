import { z } from 'zod';
import { invitationRootsSchema, workspaceRoleSchema } from './invitations.ts';

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

export const workspaceSecurityUpdateSchema = z.union([
  z.strictObject({
    expectedVersion: z.int().positive(),
    requireStrongAuth: z.boolean(),
    graceDays: z.int().min(0).max(30),
    allowPersistentCache: z.boolean().optional(),
  }),
  z.strictObject({ expectedVersion: z.int().positive(), allowPersistentCache: z.boolean() }),
]);
export const workspaceRoleUpdateSchema = z
  .strictObject({
    expectedRole: workspaceRoleSchema,
    role: workspaceRoleSchema,
    roots: invitationRootsSchema.default([]),
  })
  .refine((v) => (v.role === 'guest' ? v.roots.length > 0 : v.roots.length === 0));
export const workspaceSecuritySchema = z.strictObject({
  requireStrongAuth: z.boolean(),
  graceDays: z.int(),
  version: z.int(),
  enabledAt: z.string().nullable(),
  deadline: z.string().nullable(),
  role: workspaceRoleSchema,
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
    z.strictObject({
      workspace: z.uuid(),
      version: z.int().positive(),
      accessVersion: z.int().positive(),
      allowed: z.boolean(),
    }),
  ),
});
export const pageAccessSnapshotSchema = z.strictObject({
  accessVersion: z.int().positive(),
  pages: z
    .array(
      z.strictObject({
        page: z.uuid(),
        version: z.int().positive(),
        level: z.enum(['read', 'edit']),
      }),
    )
    .max(1000),
});
export const workspaceMembersSchema = z.array(
  z.strictObject({
    id: z.uuid(),
    name: z.string(),
    role: z.enum(['owner', 'member', 'admin', 'guest']),
    deadline: z.string().nullable(),
  }),
);
export type WorkspaceMember = z.infer<typeof workspaceMembersSchema>[number];
export type WorkspaceRole = z.infer<typeof workspaceRoleSchema>;
export type InvitationRoot = z.infer<typeof invitationRootsSchema>[number];
export const accessDraftSchema = z.object({
  email: z.string(),
  role: z.enum(['admin', 'member', 'guest']),
  roots: invitationRootsSchema,
  editing: workspaceMembersSchema.element.nullable(),
  memberRole: workspaceRoleSchema,
  memberRoots: invitationRootsSchema,
});
