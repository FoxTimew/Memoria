import type { Pool, PoolClient } from 'pg';
import { FileBoundary, FileFault } from './file-boundary.ts';
import { resolvePageAccess } from './access.ts';
import type { PageAccessRequest } from './access.ts';
import { readFileLimits } from './file-limits.ts';
import type { FileLimits } from './file-limits.ts';

/** Internal files-cell CAS, deliberately not exposed by the general database HTTP schema yet.
 * All values live in the authoritative usage ledger, in the same transaction as the cell version. */
export class FileCells {
  private readonly boundary: FileBoundary;
  constructor(
    readonly pool: Pool,
    readonly limits: FileLimits = readFileLimits(),
  ) {
    this.boundary = new FileBoundary(pool, limits);
  }
  private async items(c: PoolClient, workspace: string, page: string, property: string) {
    return (
      await c.query<{ file_id: string }>(
        "SELECT file_id FROM file_usages WHERE workspace_id=$1 AND page_id=$2 AND slot_kind='cell' AND slot_id=$3 ORDER BY file_id",
        [workspace, page, property],
      )
    ).rows.map((r) => r.file_id);
  }
  private async visible(c: PoolClient, workspace: string, ids: string[]) {
    return (
      await c.query<{ id: string; name: string }>(
        "SELECT id,original_name AS name FROM files WHERE workspace_id=$1 AND id=ANY($2::uuid[]) AND state='ready' AND deleted_at IS NULL ORDER BY id",
        [workspace, ids],
      )
    ).rows;
  }
  async write(
    a: PageAccessRequest,
    property: string,
    expectedSchemaVersion: string,
    expectedVersion: string,
    change: { add: string[]; remove: string[]; clearVisible?: boolean },
  ) {
    const identifier = /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i;
    if (
      !a.rowScope ||
      ![a.workspace, a.page, property, a.rowScope.database].every((id) => identifier.test(id)) ||
      !/^\d{1,18}$/.test(expectedVersion) ||
      !/^\d{1,18}$/.test(expectedSchemaVersion) ||
      !Array.isArray(change.add) ||
      !Array.isArray(change.remove) ||
      change.add.length > this.limits.cellFiles ||
      change.remove.length > this.limits.cellFiles ||
      [...change.add, ...change.remove].some((id) => !identifier.test(id)) ||
      new Set([...change.add, ...change.remove]).size !== change.add.length + change.remove.length
    )
      throw new FileFault('INVALID_FILE_CELL', 400);
    const preliminary = await this.pool.connect();
    let before: string[];
    try {
      before = await this.items(preliminary, a.workspace, a.page, property);
    } finally {
      preliminary.release();
    }
    const plan = await this.boundary.plan(
      change.add
        .filter((file) => !before.includes(file))
        .map((file) => ({ slot: property, file, author: a })),
      a.page,
      before,
    );
    return this.boundary.transaction(async (c) => {
      await this.boundary.lock(c, a.workspace, plan);
      const access = (await resolvePageAccess(c, [a])).get(a.key);
      if (access?.level !== 'edit') throw new FileFault('FILE_UNAVAILABLE');
      const schema = (
        await c.query<{ schema_version: string }>(
          `SELECT d.schema_version FROM databases d JOIN database_properties p ON p.workspace_id=d.workspace_id AND p.database_id=d.id WHERE d.workspace_id=$1 AND d.id=$2 AND d.deleted_at IS NULL AND p.id=$3 AND p.deleted_at IS NULL AND p.kind::text='files'`,
          [a.workspace, a.rowScope!.database, property],
        )
      ).rows[0];
      if (!schema) throw new FileFault('FILE_UNAVAILABLE');
      if (schema.schema_version !== expectedSchemaVersion)
        throw new FileFault('SCHEMA_VERSION_CONFLICT', 409);
      await c.query(
        'INSERT INTO database_cell_versions(workspace_id,database_id,row_page_id,property_id) VALUES($1,$2,$3,$4) ON CONFLICT DO NOTHING',
        [a.workspace, a.rowScope!.database, a.page, property],
      );
      const version = (
        await c.query<{ version: string }>(
          'SELECT version FROM database_cell_versions WHERE workspace_id=$1 AND row_page_id=$2 AND property_id=$3 FOR UPDATE',
          [a.workspace, a.page, property],
        )
      ).rows[0]!.version;
      const actual = await this.items(c, a.workspace, a.page, property);
      if (version !== expectedVersion) throw new FileFault('CELL_VERSION_CONFLICT', 409);
      if (JSON.stringify(actual) !== JSON.stringify(before))
        throw new FileFault('RETRY_REQUIRED', 409);
      const visible = await this.visible(c, a.workspace, actual),
        visibleIds = new Set(visible.map((r) => r.id));
      if (
        change.remove.some((id) => !visibleIds.has(id)) ||
        change.add.some((id) => actual.includes(id) && !visibleIds.has(id))
      )
        throw new FileFault('FILE_UNAVAILABLE');
      const remove = change.clearVisible
        ? actual.filter((id) => visibleIds.has(id))
        : change.remove;
      const next = [
        ...new Set([...actual.filter((id) => !remove.includes(id)), ...change.add]),
      ].sort();
      if (next.length > this.limits.cellFiles) throw new FileFault('FILE_CELL_LIMIT', 413);
      await this.boundary.authorize(c, plan);
      const otherCount = Number(
        (
          await c.query<{ n: string }>(
            "SELECT count(*) n FROM file_usages WHERE workspace_id=$1 AND page_id=$2 AND NOT(slot_kind='cell' AND slot_id=$3)",
            [a.workspace, a.page, property],
          )
        ).rows[0]!.n,
      );
      if (otherCount + next.length > this.limits.pageReferences)
        throw new FileFault('FILE_REFERENCE_LIMIT', 413);
      await c.query(
        "DELETE FROM file_usages WHERE workspace_id=$1 AND page_id=$2 AND slot_kind='cell' AND slot_id=$3 AND file_id=ANY($4::uuid[])",
        [a.workspace, a.page, property, remove],
      );
      const revision = (BigInt(version) + 1n).toString();
      for (const id of next.filter((id) => !actual.includes(id))) {
        if (
          Number(
            (
              await c.query<{ n: string }>(
                'SELECT count(*) n FROM file_usages WHERE workspace_id=$1 AND file_id=$2',
                [a.workspace, id],
              )
            ).rows[0]!.n,
          ) >= this.limits.fileUsages
        )
          throw new FileFault('FILE_USAGE_LIMIT', 413);
        await c.query(
          "INSERT INTO file_usages(workspace_id,file_id,page_id,slot_kind,slot_id,revision) VALUES($1,$2,$3,'cell',$4,$5)",
          [a.workspace, id, a.page, property, revision],
        );
      }
      await c.query(
        'UPDATE database_cell_versions SET version=$1 WHERE workspace_id=$2 AND row_page_id=$3 AND property_id=$4',
        [revision, a.workspace, a.page, property],
      );
      await c.query('SELECT database_mark_row($1,$2,$3,$4)', [
        a.workspace,
        a.rowScope!.database,
        a.page,
        access.actor,
      ]);
      const items = await this.visible(c, a.workspace, next);
      return { version: revision, value: { items, hasHidden: items.length !== next.length } };
    });
  }
}
