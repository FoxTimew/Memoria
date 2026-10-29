import type { Pool, PoolClient } from 'pg';
import { FileBoundary, FileFault } from './file-boundary.ts';
import { resolvePageAccess } from './access.ts';
import type { PageAccessRequest } from './access.ts';

export type FileVariant = 'original' | 'display' | 'thumbnail';
export type FileReadClaim = {
  user: string;
  session: string;
  workspace: string;
  page: string;
  file: string;
  usage: string;
  generation: string | null;
  accessVersion: number;
  database: string | null;
  lifecycle: string | null;
  fileVersion: number;
  variant: FileVariant;
};
type Resource = {
  usage: string;
  generation: string | null;
  database: string | null;
  lifecycle: string | null;
  access_version: number;
  validation_version: number;
  object_key: string;
  original_name: string;
  byte_size: string;
  mime_type: string;
  preview_status: string;
  pixel_width: number | null;
  pixel_height: number | null;
  deleted_at: Date | null;
};
const unavailable = () => new FileFault('FILE_UNAVAILABLE');
export class FileReading {
  readonly boundary: FileBoundary;
  constructor(readonly pool: Pool) {
    this.boundary = new FileBoundary(pool);
  }
  private async resource(
    c: Pool | PoolClient,
    a: PageAccessRequest,
    file: string,
    archived = false,
  ) {
    const row = (
      await c.query<Resource>(
        `SELECT f.*,u.id AS usage,u.generation,r.database_id AS database,r.lifecycle_version::text AS lifecycle,e.version AS access_version
      FROM files f JOIN file_usages u ON u.workspace_id=f.workspace_id AND u.file_id=f.id AND u.page_id=$3
      JOIN workspace_members m ON m.workspace_id=f.workspace_id AND m.user_id=$4
      LEFT JOIN database_rows r ON r.workspace_id=u.workspace_id AND r.page_id=u.page_id
      LEFT JOIN databases d ON d.workspace_id=r.workspace_id AND d.id=r.database_id
      JOIN page_access_state e ON e.workspace_id=f.workspace_id AND e.member_id=m.id AND e.page_id=coalesce(d.page_id,u.page_id) AND e.level<>'none'
      WHERE f.workspace_id=$1 AND f.id=$2 AND f.state='ready' AND ($5 OR f.deleted_at IS NULL)
      AND ((u.slot_kind='cell' AND EXISTS(SELECT 1 FROM database_properties p WHERE p.id=u.slot_id AND p.workspace_id=u.workspace_id AND p.database_id=r.database_id AND p.deleted_at IS NULL)) OR
      (u.slot_kind='block' AND EXISTS(SELECT 1 FROM collaboration_documents cd JOIN file_ledger_states l ON l.page_id=cd.page_id AND l.generation=cd.generation AND l.revision=cd.content_revision WHERE cd.page_id=u.page_id AND u.generation=cd.generation)))
      ORDER BY u.id LIMIT 1`,
        [a.workspace, file, a.page, a.user, archived],
      )
    ).rows[0];
    if (!row) throw unavailable();
    if (a.rowScope && a.rowScope.database !== row.database) throw unavailable();
    const request = {
      ...a,
      ...(row.database ? { rowScope: { ...a.rowScope, database: row.database } } : {}),
    };
    if (!(await resolvePageAccess(c, [request])).has(a.key)) throw unavailable();
    return row;
  }
  async metadata(a: PageAccessRequest, file: string) {
    const r = await this.resource(this.pool, a, file);
    return {
      id: file,
      name: r.original_name,
      bytes: Number(r.byte_size),
      mime: r.mime_type,
      preview: r.preview_status,
      version: r.validation_version,
      width: r.pixel_width,
      height: r.pixel_height,
    };
  }
  async issue(a: PageAccessRequest, file: string, variant: FileVariant): Promise<FileReadClaim> {
    return this.boundary.transaction(async (c) => {
      await this.boundary.lock(c, a.workspace, {
        destination: a.page,
        pages: [a.page],
        files: [file],
        sources: [],
      });
      const r = await this.resource(c, a, file);
      if (
        variant !== 'original' &&
        !(
          await c.query('SELECT 1 FROM file_variants WHERE file_id=$1 AND variant=$2', [
            file,
            variant,
          ])
        ).rowCount
      )
        throw unavailable();
      return {
        user: a.user,
        session: a.session,
        workspace: a.workspace,
        page: a.page,
        file,
        usage: r.usage,
        generation: r.generation,
        accessVersion: r.access_version,
        database: r.database,
        lifecycle: r.lifecycle,
        fileVersion: r.validation_version,
        variant,
      };
    });
  }
  async authorize(claim: FileReadClaim) {
    const a: PageAccessRequest = {
      key: 'file-read',
      user: claim.user,
      session: claim.session,
      workspace: claim.workspace,
      page: claim.page,
      ...(claim.database
        ? {
            rowScope: {
              database: claim.database,
              baseVersion: claim.accessVersion,
              lifecycle: claim.lifecycle!,
            },
          }
        : { accessVersion: claim.accessVersion }),
    };
    const r = await this.resource(this.pool, a, claim.file);
    if (
      r.usage !== claim.usage ||
      r.generation !== claim.generation ||
      r.validation_version !== claim.fileVersion ||
      r.access_version !== claim.accessVersion ||
      r.lifecycle !== claim.lifecycle
    )
      throw unavailable();
    if (claim.variant === 'original')
      return {
        key: r.object_key,
        bytes: Number(r.byte_size),
        mime: 'application/octet-stream',
        name: r.original_name,
        inline: false,
      };
    const v = (
      await this.pool.query<{ object_key: string; byte_size: string }>(
        'SELECT object_key,byte_size FROM file_variants WHERE file_id=$1 AND variant=$2',
        [claim.file, claim.variant],
      )
    ).rows[0];
    if (!v) throw unavailable();
    return {
      key: v.object_key,
      bytes: Number(v.byte_size),
      mime: 'image/webp',
      name: claim.variant + '.webp',
      inline: true,
    };
  }
  async lifecycle(a: PageAccessRequest, file: string, version: number, restore: boolean) {
    return this.boundary.transaction(async (c) => {
      await this.boundary.lock(c, a.workspace, {
        destination: a.page,
        pages: [a.page],
        files: [file],
        sources: [],
      });
      const r = await this.resource(c, a, file, true);
      if (
        !(
          await c.query(
            "SELECT 1 FROM workspace_members WHERE workspace_id=$1 AND user_id=$2 AND role IN ('owner','admin','member')",
            [a.workspace, a.user],
          )
        ).rowCount
      )
        throw new FileFault('FILE_ACTION_FORBIDDEN', 403);
      if (r.validation_version !== version) throw new FileFault('FILE_VERSION_CONFLICT', 409);
      await c.query(
        'UPDATE files SET deleted_at=CASE WHEN $2 THEN NULL ELSE clock_timestamp() END,validation_version=validation_version+1,updated_at=clock_timestamp() WHERE id=$1',
        [file, restore],
      );
      await c.query(
        "INSERT INTO audit_logs(workspace_id,actor_id,action,resource_type,resource_id,metadata) SELECT $1,id,$4,'file',$3,'{}'::jsonb FROM actors WHERE workspace_id=$1 AND user_id=$2 AND kind='user'",
        [a.workspace, a.user, file, restore ? 'file.restored' : 'file.archived'],
      );
      return { version: version + 1, archived: !restore };
    });
  }
}
