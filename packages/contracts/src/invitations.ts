import { z } from 'zod';
export const workspaceRoleSchema = z.enum(['owner', 'admin', 'member', 'guest']);
export const invitationRootsSchema = z
  .array(z.strictObject({ pageId: z.uuid(), level: z.enum(['read', 'edit']) }))
  .max(20)
  .refine((roots) => new Set(roots.map((r) => r.pageId)).size === roots.length);
export const invitationCreateSchema = z
  .strictObject({
    email: z
      .email()
      .max(254)
      .transform((v) => v.toLowerCase()),
    role: z.enum(['admin', 'member', 'guest']),
    roots: invitationRootsSchema.default([]),
  })
  .refine((v) => (v.role === 'guest' ? v.roots.length > 0 : v.roots.length === 0));
export const invitationIdSchema = z.strictObject({ id: z.uuid() });
export const accessPaginationSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(100000).default(0),
});
export const invitationSummarySchema = z.object({
  id: z.uuid(),
  workspaceId: z.uuid(),
  workspaceName: z.string(),
  role: z.enum(['admin', 'member', 'guest']),
  status: z.string(),
  expiresAt: z.string(),
  deliveryStatus: z.string(),
  email: z.string().optional(),
  link: z.string().optional(),
  roots: invitationRootsSchema.optional(),
});
export type InvitationSummary = z.infer<typeof invitationSummarySchema>;
export const invitationListSchema = z.array(invitationSummarySchema);
export const arrivalSchema = z.object({
  workspaceId: z.uuid(),
  role: workspaceRoleSchema,
  contentAllowed: z.boolean(),
  requiresStrongAuth: z.boolean(),
});
