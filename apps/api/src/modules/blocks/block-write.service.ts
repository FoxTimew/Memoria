import {
  BadRequestException,
  ConflictException,
  HttpException,
  Injectable,
  ServiceUnavailableException,
} from '@nestjs/common';
import { internalSignature } from '@memoria/auth/collaboration';
import {
  collaborationOpenSchema,
  collaborationWriteSchema,
  canonicalJson,
} from '@memoria/contracts';
import type { CollaborationCommand } from '@memoria/contracts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import { readConfig } from '../../config.ts';
import * as database from '../../database.module.ts';
import { pages } from '@memoria/db';
import { and, eq } from 'drizzle-orm';
import { contentContext, pageRights, requirePageRight, uuid } from '../pages/content-access.ts';
/** Sole non-editor write facade. No SQL block mutation and no fallback during collaboration outage. */
@Injectable()
export class BlockWriteService {
  constructor(private readonly database: database.DatabaseService) {}
  private async check(
    session: AuthenticatedSession,
    workspace: string,
    page: string,
    write: boolean,
  ) {
    uuid(page);
    await this.database.db.transaction(async (tx) => {
      await contentContext(tx, session, workspace, false);
      const selected = await tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, workspace), eq(pages.id, page)));
      requirePageRight(await pageRights(tx, session, workspace, selected), page, write);
    });
    // This is only the HTTP response boundary. Collab rechecks after its page lock;
    // this transaction is over before forwarding, so it cannot grant a reusable permit.
  }
  async open(session: AuthenticatedSession, workspace: string, page: string) {
    await this.check(session, workspace, page, false);
    const opened = await this.forward({
      action: 'open',
      user: session.userId,
      session: session.id,
      workspace,
      page,
    });
    return {
      ...collaborationOpenSchema.parse(opened),
      identity: { user: session.userId, session: session.id },
    };
  }
  async write(session: AuthenticatedSession, workspace: string, page: string, input: unknown) {
    const parsed = collaborationWriteSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Commande collaborative invalide.');
    await this.check(session, workspace, page, true);
    return this.forward({
      action: 'write',
      user: session.userId,
      session: session.id,
      workspace,
      page,
      ...parsed.data,
    });
  }
  private async forward(command: CollaborationCommand) {
    const config = readConfig(),
      url = new URL(config.COLLAB_INTERNAL_URL),
      body = canonicalJson(command);
    let response: Response;
    try {
      response = await fetch(url, {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...internalSignature(config.COLLAB_INTERNAL_SECRET, url.pathname, body),
        },
        body,
        signal: AbortSignal.timeout(20000),
        redirect: 'error',
      });
    } catch {
      throw new ServiceUnavailableException({
        code: 'COLLAB_UNAVAILABLE',
        message: 'Service collaboratif indisponible. Réessayez avec le même reçu.',
      });
    }
    const result: unknown = await response.json();
    if (!response.ok) {
      if (response.status === 409) throw new ConflictException(result as object);
      throw new HttpException(result as object, response.status >= 500 ? 503 : response.status);
    }
    return result;
  }
}
