import type { Client } from 'pg';
import { createHash } from 'node:crypto';
import type { BlockEnvelope } from '@memoria/blocks-core';

import type { WriteIdentity } from '../journal.ts';
export interface JournalEntry {
  identity: WriteIdentity;
  receipt: string;
  update: Uint8Array;
}

/** One page lock/transaction per validated batch, one durable receipt per original update.
 * The caller serializes validation, commit and live application for this room. */
export async function appendBatch(
  client: Client,
  entries: readonly JournalEntry[],
  merged: Uint8Array,
  blocks: readonly BlockEnvelope[],
) {
  if (!entries.length) throw new Error('Empty batch');
  const identity = entries[0]!.identity;
  if (
    entries.some(
      (e) => e.identity.page !== identity.page || e.identity.workspace !== identity.workspace,
    )
  )
    throw new Error('Mixed rooms');
  const unique = new Map<string, JournalEntry>();
  for (const entry of entries) {
    const old = unique.get(entry.receipt);
    if (
      old &&
      (old.identity.user !== entry.identity.user ||
        !Buffer.from(old.update).equals(Buffer.from(entry.update)))
    )
      throw new Error('Receipt reuse');
    unique.set(entry.receipt, entry);
  }
  const records = [...unique.values()].map((e) => ({
    receipt: e.receipt,
    author: e.identity.user,
    hash: createHash('sha256').update(e.update).digest('hex'),
  }));
  await client.query('BEGIN');
  try {
    const locked = await client.query(
      'SELECT id FROM pages WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE',
      [identity.page, identity.workspace],
    );
    if (locked.rowCount !== 1) throw new Error('Access denied');
    const access = await client.query(
      `WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,deleted_at FROM pages WHERE id=$1 AND workspace_id=$2
      UNION ALL SELECT p.id,p.parent_id,p.deleted_at FROM pages p JOIN ancestors a ON p.id=a.parent_id WHERE p.workspace_id=$2
    ) SELECT candidate.session FROM jsonb_to_recordset($3::jsonb) AS candidate(session uuid,userid uuid)
      JOIN auth_sessions s ON s.id=candidate.session AND s.user_id=candidate.userid
      JOIN auth_users u ON u.id=s.user_id
      JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$2 JOIN workspaces w ON w.id=m.workspace_id
      WHERE s.expires_at>clock_timestamp() AND u.email_verified AND m.role IN ('owner','member') AND w.deleted_at IS NULL
      AND NOT EXISTS(SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
      [
        identity.page,
        identity.workspace,
        JSON.stringify(
          entries.map((e) => ({ session: e.identity.session, userid: e.identity.user })),
        ),
      ],
    );
    if (access.rowCount !== entries.length) throw new Error('Access denied');
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
    const existing = await client.query<{
      receipt: string;
      revision: string;
      update_hash: string;
      author_id: string;
    }>(
      'SELECT receipt,revision,update_hash,author_id FROM collaboration_receipts WHERE page_id=$1 AND receipt=ANY($2::uuid[])',
      [identity.page, records.map((r) => r.receipt)],
    );
    const revisions = new Map<string, number>();
    for (const row of existing.rows) {
      const record = records.find((r) => r.receipt === row.receipt)!;
      if (record.author !== row.author_id || record.hash !== row.update_hash)
        throw new Error('Receipt reuse');
      revisions.set(row.receipt, Number(row.revision));
    }
    const fresh = records.filter((r) => !revisions.has(r.receipt));
    if (fresh.length) {
      const result = await client.query<{ content_revision: string }>(
        'UPDATE collaboration_documents SET content_revision=content_revision+1 WHERE page_id=$1 RETURNING content_revision',
        [identity.page],
      );
      if (!result.rows[0]) throw new Error('Document not initialized');
      const next = Number(result.rows[0].content_revision);
      // Legacy column is the initiating author only. All contributors live in receipts.
      await client.query(
        'INSERT INTO collaboration_updates(page_id,revision,receipt,author_id,update) VALUES($1,$2,$3,$4,$5)',
        [identity.page, next, fresh[0]!.receipt, fresh[0]!.author, Buffer.from(merged)],
      );
      await client.query(
        `INSERT INTO collaboration_receipts(page_id,receipt,revision,author_id,update_hash)
        SELECT $1,r.receipt,$2,r.author,r.hash FROM jsonb_to_recordset($3::jsonb) AS r(receipt uuid,author uuid,hash text)`,
        [identity.page, next, JSON.stringify(fresh)],
      );
      for (const record of fresh) revisions.set(record.receipt, next);
    }
    await client.query('COMMIT');
    return revisions;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  }
}
