import type { Pool, PoolClient } from 'pg';
import type { FileLimits } from './file-limits.ts';
import { FileFault } from './file-fault.ts';

/** Logical reservations across all tenants. Never queries the object store under this latch.
 * Physical disk free space and provider overhead must still be monitored by the operator. */
export async function lockFileCapacity(c: PoolClient) {
  await c.query("SELECT pg_advisory_xact_lock(hashtextextended('file-storage-capacity',0))");
}
const workspaceTotals = `SELECT f.workspace_id,
  coalesce(sum(coalesce(i.reserved_bytes,f.byte_size)),0)::text reserved_bytes,
  count(*)::text files_count,
  coalesce(sum(i.requested_bytes) FILTER(WHERE i.staging_cleaned_at IS NULL),0)::text staging_bytes
  FROM files f LEFT JOIN file_upload_intents i ON i.file_id=f.id
  WHERE f.state<>'deleted' GROUP BY f.workspace_id`;

export async function readFileCapacity(c: PoolClient) {
  const r = (
    await c.query<{ reserved: string; staging: string; copies: string }>(`
    WITH totals AS (${workspaceTotals})
    SELECT coalesce((SELECT sum(reserved_bytes::numeric) FROM totals),0)::text reserved,
    coalesce((SELECT sum(staging_bytes::numeric) FROM totals),0)::text staging,
    coalesce((SELECT sum(i.requested_bytes) FROM file_object_copies o
      JOIN file_upload_intents i ON i.file_id=o.file_id WHERE o.deleted_at IS NULL
      AND NOT (i.final_key IS NOT DISTINCT FROM o.object_key AND i.bytes_verified_at IS NOT NULL)),0)::text copies
  `)
  ).rows[0]!;
  return { reserved: BigInt(r.reserved), staging: BigInt(r.staging), copies: BigInt(r.copies) };
}
export async function admitFileCapacity(
  c: PoolClient,
  limits: FileLimits,
  delta: { reserved: number; staging: number; copies: number },
) {
  await lockFileCapacity(c);
  const used = await readFileCapacity(c);
  const reserved = used.reserved + BigInt(delta.reserved),
    staging = used.staging + BigInt(delta.staging),
    copies = used.copies + BigInt(delta.copies);
  if (staging > BigInt(limits.stagingBytes)) throw new FileFault('FILE_STAGING_CAPACITY', 429);
  if (copies > BigInt(limits.copyBytes)) throw new FileFault('FILE_COPY_CAPACITY', 429);
  if (reserved + staging + copies > BigInt(limits.capacityBytes))
    throw new FileFault('FILE_STORAGE_CAPACITY', 429);
}

export async function assertFileAccounting(c: PoolClient, workspace: string) {
  const result = await c.query(
    `WITH expected AS (
    SELECT coalesce(sum(coalesce(i.reserved_bytes,f.byte_size)),0) bytes,count(*) n
    FROM files f LEFT JOIN file_upload_intents i ON i.file_id=f.id
    WHERE f.workspace_id=$1 AND f.state<>'deleted')
    SELECT 1 FROM expected e LEFT JOIN file_workspace_usage u ON u.workspace_id=$1
    WHERE e.bytes<>coalesce(u.reserved_bytes,0) OR e.n<>coalesce(u.files_count,0)`,
    [workspace],
  );
  if (result.rowCount) throw new FileFault('FILE_ACCOUNTING_DRIFT', 503);
}

/** Single MVCC statement compares authoritative reservations with accounting, including legacy
 * files without an upload intent. Only an explicit operator repair may correct the counters. */
export async function reconcileFileCapacity(pool: Pool, repair = false) {
  const c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='5s'");
    await lockFileCapacity(c);
    const drift = (
      await c.query<{ workspace_id: string; expected_bytes: string; expected_count: string }>(`
      WITH expected AS (${workspaceTotals})
      SELECT coalesce(e.workspace_id,u.workspace_id) workspace_id,
        coalesce(e.reserved_bytes,'0') expected_bytes,coalesce(e.files_count,'0') expected_count
      FROM expected e FULL JOIN file_workspace_usage u ON u.workspace_id=e.workspace_id
      WHERE coalesce(e.reserved_bytes::numeric,0) IS DISTINCT FROM u.reserved_bytes
         OR coalesce(e.files_count::numeric,0) IS DISTINCT FROM u.files_count
    `)
    ).rows;
    if (repair)
      for (const row of drift)
        await c.query(
          `INSERT INTO file_workspace_usage(workspace_id,reserved_bytes,files_count) VALUES($1,$2,$3)
       ON CONFLICT(workspace_id) DO UPDATE SET reserved_bytes=EXCLUDED.reserved_bytes,files_count=EXCLUDED.files_count`,
          [row.workspace_id, row.expected_bytes, row.expected_count],
        );
    const capacity = await readFileCapacity(c);
    const legacy = (
      await c.query<{ files: string; documents: string }>(`SELECT
      (SELECT count(*) FROM files f WHERE f.state<>'deleted' AND NOT EXISTS(SELECT 1 FROM file_upload_intents i WHERE i.file_id=f.id))::text files,
      (SELECT count(*) FROM collaboration_documents d LEFT JOIN file_ledger_states l ON l.page_id=d.page_id
        WHERE l.page_id IS NULL OR l.generation<>d.generation OR l.revision<>d.content_revision)::text documents`)
    ).rows[0]!;
    await c.query('COMMIT');
    // No names, emails, object keys, tokens or file IDs in metrics/logs.
    return {
      driftWorkspaces: drift.length,
      repaired: repair ? drift.length : 0,
      reservedBytes: capacity.reserved.toString(),
      stagingBytes: capacity.staging.toString(),
      copyBytes: capacity.copies.toString(),
      legacyFiles: Number(legacy.files),
      documentsToInspect: Number(legacy.documents),
    };
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
