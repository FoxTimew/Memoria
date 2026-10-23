import { BadRequestException, ConflictException, Injectable } from '@nestjs/common';
import { and, eq, isNull } from 'drizzle-orm';
import {
  accessSubjects,
  actors,
  auditLogs,
  member,
  organization,
  workspacePolicies,
} from '@memoria/db';
import { createWorkspaceSchema } from '@memoria/contracts';
import * as database from '../../database.module.ts';
import * as auth from '../auth/auth.service.ts';

@Injectable()
export class WorkspacesService {
  constructor(
    private readonly database: database.DatabaseService,
    private readonly auth: auth.AuthService,
  ) {}

  list(userId: string) {
    return this.database.db
      .select({
        id: organization.id,
        name: organization.name,
        slug: organization.slug,
        role: member.role,
      })
      .from(organization)
      .innerJoin(member, eq(member.organizationId, organization.id))
      .where(and(eq(member.userId, userId), isNull(organization.deletedAt)))
      .orderBy(organization.createdAt);
  }

  async create(userId: string, input: unknown) {
    const parsed = createWorkspaceSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Nom ou identifiant de workspace invalide.');
    try {
      return await this.database.db.transaction(async (tx) => {
        // The plugin's organization + member inserts and our sidecars share one transaction.
        const created = await this.auth.inTransaction(tx).api.createOrganization({
          body: { ...parsed.data, userId, keepCurrentActiveOrganization: true },
        });
        if (!created) throw new Error('Workspace creation failed');
        const owner = created.members[0];
        if (!owner) throw new Error('Missing workspace owner');
        const [actor] = await tx
          .insert(actors)
          .values({ workspaceId: created.id, kind: 'user', userId })
          .returning();
        if (!actor) throw new Error('Missing workspace actor');
        await tx
          .insert(workspacePolicies)
          .values({ workspaceId: created.id, createdBy: actor.id, updatedBy: actor.id });
        await tx.insert(accessSubjects).values({
          workspaceId: created.id,
          kind: 'member',
          memberId: owner.id,
          createdBy: actor.id,
          updatedBy: actor.id,
        });
        await tx.insert(auditLogs).values({
          workspaceId: created.id,
          actorId: actor.id,
          action: 'workspace.created',
          resourceType: 'workspace',
          resourceId: created.id,
        });
        return { id: created.id, name: created.name, slug: created.slug, role: 'owner' as const };
      });
    } catch (error) {
      let databaseError: unknown = error;
      while (databaseError && typeof databaseError === 'object' && 'cause' in databaseError)
        databaseError = databaseError.cause;
      const code =
        databaseError && typeof databaseError === 'object' && 'code' in databaseError
          ? databaseError.code
          : undefined;
      const body = error && typeof error === 'object' && 'body' in error ? error.body : undefined;
      if (
        code === '23505' ||
        (body &&
          typeof body === 'object' &&
          'code' in body &&
          body.code === 'ORGANIZATION_ALREADY_EXISTS')
      ) {
        throw new ConflictException('Cet identifiant de workspace est déjà utilisé.');
      }
      throw error;
    }
  }
}
