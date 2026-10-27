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
  collaborationRowAccessSchema,
} from '@memoria/contracts';
import type { CollaborationCommand } from '@memoria/contracts';
import type { AuthenticatedSession } from '../auth/current-user.decorator.ts';
import type { SessionIdentity } from '@memoria/auth';
import { readConfig } from '../../config.ts';
import * as database from '../../database.module.ts';
import type { PoolClient } from '@memoria/db';
import { initialDocument } from '@memoria/collaboration-core';
import { pages } from '@memoria/db';
import { resolvePageAccess, DatabaseFault } from '@memoria/db';
import { and, eq, sql } from 'drizzle-orm';
import { contentContext, pageRights, requirePageRight, uuid } from '../pages/content-access.ts';
/** Sole non-editor write facade. No SQL block mutation and no fallback during collaboration outage. */
@Injectable()
export class BlockWriteService {
  constructor(private readonly database: database.DatabaseService) {}
  /** Called inside the row creation transaction; the validator replica is loaded lazily. */
  async initializeRow(c: PoolClient, workspace: string, page: string) {
    const { snapshot, businessBytes } = initialDocument();
    await c.query(
      'INSERT INTO collaboration_documents(workspace_id,page_id,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5)',
      [workspace, page, snapshot, snapshot.length, businessBytes],
    );
  }
  private async check(
    session: AuthenticatedSession,
    workspace: string,
    page: string,
    write: boolean,
  ) {
    uuid(page);
    return this.database.db.transaction(async (tx) => {
      await contentContext(tx, session, workspace, false);
      const selected = await tx
        .select()
        .from(pages)
        .where(and(eq(pages.workspaceId, workspace), eq(pages.id, page)));
      const rights = await pageRights(tx, session, workspace, selected);
      requirePageRight(rights, page, write);
      const row = (
        await tx.execute<{ version: number }>(
          sql`SELECT e.version FROM page_access_state e JOIN workspace_members m ON m.id=e.member_id AND m.workspace_id=e.workspace_id
          WHERE e.workspace_id=${workspace}::uuid AND m.user_id=${session.userId}::uuid AND e.page_id=${page}::uuid AND e.level<>'none'`,
        )
      ).rows[0]!;
      return { level: rights.get(page)!, accessVersion: row.version };
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
      ...(await this.check(session, workspace, page, false)),
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
  async rowAccess(
    session: SessionIdentity,
    workspace: string,
    database: string,
    page: string,
    write = false,
  ) {
    for (const value of [workspace, database, page]) uuid(value);
    const c = await this.database.pool.connect();
    try {
      await c.query('BEGIN');
      await c.query('SELECT id FROM databases WHERE workspace_id=$1 AND id=$2 FOR SHARE', [
        workspace,
        database,
      ]);
      await c.query(
        'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND database_id=$2 AND page_id=$3 FOR SHARE',
        [workspace, database, page],
      );
      const request = {
        key: page,
        user: session.userId,
        session: session.id,
        workspace,
        page,
        rowScope: { database },
      };
      const a = (await resolvePageAccess(c, [request])).get(page);
      if (!a || (write && a.level !== 'edit')) throw new DatabaseFault(404, 'ACCESS_DENIED');
      const state = (
        await c.query<{ version: number; lifecycle: string }>(
          "SELECT e.version,r.lifecycle_version::text AS lifecycle FROM databases d JOIN database_rows r ON r.workspace_id=d.workspace_id AND r.database_id=d.id JOIN workspace_members m ON m.workspace_id=d.workspace_id AND m.user_id=$4 JOIN page_access_state e ON e.workspace_id=d.workspace_id AND e.page_id=d.page_id AND e.member_id=m.id WHERE d.workspace_id=$1 AND d.id=$2 AND r.page_id=$3 AND e.level<>'none'",
          [workspace, database, page, session.userId],
        )
      ).rows[0];
      if (!state) throw new DatabaseFault(404, 'ACCESS_DENIED');
      if (!(await resolvePageAccess(c, [request])).has(page))
        throw new DatabaseFault(404, 'ACCESS_DENIED');
      await c.query('COMMIT');
      return {
        level: a.level,
        rowScope: { database, baseVersion: state.version, lifecycle: state.lifecycle },
      };
    } catch (e) {
      await c.query('ROLLBACK');
      throw e;
    } finally {
      c.release();
    }
  }
  async openRow(session: SessionIdentity, workspace: string, database: string, page: string) {
    const before = await this.rowAccess(session, workspace, database, page);
    const opened = await this.forward({
      action: 'open',
      user: session.userId,
      session: session.id,
      workspace,
      page,
      rowScope: before.rowScope,
    });
    const after = await this.rowAccess(session, workspace, database, page);
    if (canonicalJson(before) !== canonicalJson(after))
      throw new ConflictException({ code: 'ROW_ACCESS_CHANGED' });
    return collaborationRowAccessSchema.parse({
      ...collaborationOpenSchema.parse(opened),
      identity: { user: session.userId, session: session.id },
      scope: 'database-row',
      ...after,
    });
  }
  async writeRow(
    session: SessionIdentity,
    workspace: string,
    database: string,
    page: string,
    input: unknown,
  ) {
    const parsed = collaborationWriteSchema.safeParse(input);
    if (!parsed.success) throw new BadRequestException('Commande collaborative invalide.');
    const access = await this.rowAccess(session, workspace, database, page, true);
    return this.forward({
      action: 'write',
      user: session.userId,
      session: session.id,
      workspace,
      page,
      rowScope: access.rowScope,
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
