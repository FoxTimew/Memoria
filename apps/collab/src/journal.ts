import type { Client } from 'pg';
import { createHash } from 'node:crypto';
import type { BlockEnvelope } from '@memoria/blocks-core';

export interface WriteIdentity {
  user: string;
  session: string;
  workspace: string;
  page: string;
}

/** Proof journal: page row lock only. Caller serializes the room before validation. */
export async function appendUpdate(
  client: Client,
  identity: WriteIdentity,
  receipt: string,
  update: Uint8Array,
  blocks: readonly BlockEnvelope[],
) {
  await client.query('BEGIN');
  try {
    // NO KEY UPDATE still serializes page writers/revocation, but allows projection FK checks.
    const locked = await client.query(
      'SELECT id FROM pages WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE',
      [identity.page, identity.workspace],
    );
    if (locked.rowCount !== 1) throw new Error('Access denied');
    const access = await client.query(
      `WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,deleted_at FROM pages WHERE id=$1 AND workspace_id=$2
      UNION ALL SELECT p.id,p.parent_id,p.deleted_at FROM pages p JOIN ancestors a ON p.id=a.parent_id WHERE p.workspace_id=$2
    ) SELECT s.id FROM auth_sessions s
      JOIN auth_users u ON u.id=s.user_id
      JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$2
      JOIN workspaces w ON w.id=m.workspace_id
      WHERE s.id=$3 AND u.id=$4 AND s.expires_at>clock_timestamp() AND u.email_verified
        AND m.role IN ('owner','member') AND w.deleted_at IS NULL
        AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
      [identity.page, identity.workspace, identity.session, identity.user],
    );
    if (access.rowCount !== 1) throw new Error('Access denied');
    const files = [
      ...new Set(
        blocks
          .filter((b) => b.type === 'core.image')
          .map((b) => b.content.fileId)
          .filter((id) => typeof id === 'string'),
      ),
    ];
    if (files.length) {
      const valid = await client.query(
        'SELECT id FROM files WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND deleted_at IS NULL',
        [files, identity.workspace],
      );
      if (valid.rowCount !== files.length) throw new Error('File access denied');
    }
    const hash = createHash('sha256').update(update).digest('hex');
    const existing = await client.query<{
      revision: string;
      update_hash: string;
      author_id: string;
    }>(
      'SELECT revision,update_hash,author_id FROM collaboration_receipts WHERE page_id=$1 AND receipt=$2',
      [identity.page, receipt],
    );
    if (existing.rows[0]) {
      const row = existing.rows[0];
      if (row.author_id !== identity.user || row.update_hash !== hash)
        throw new Error('Receipt reuse');
      await client.query('COMMIT');
      return Number(row.revision);
    }
    const revision = await client.query<{ content_revision: string }>(
      'UPDATE collaboration_documents SET content_revision=content_revision+1 WHERE page_id=$1 RETURNING content_revision',
      [identity.page],
    );
    if (!revision.rows[0]) throw new Error('Document not initialized');
    const next = Number(revision.rows[0].content_revision);
    await client.query(
      'INSERT INTO collaboration_updates(page_id,revision,receipt,author_id,update) VALUES ($1,$2,$3,$4,$5)',
      [identity.page, next, receipt, identity.user, Buffer.from(update)],
    );
    await client.query(
      'INSERT INTO collaboration_receipts(page_id,receipt,revision,author_id,update_hash) VALUES ($1,$2,$3,$4,$5)',
      [identity.page, receipt, next, identity.user, hash],
    );
    await client.query('COMMIT');
    return next;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
