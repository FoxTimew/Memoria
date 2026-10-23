import type { Pool, PoolClient } from 'pg';
import { createHash, randomUUID } from 'node:crypto';
import * as Y from 'yjs';
import type { BlockEnvelope } from '@memoria/blocks-core';
import { decodeDocument } from '../codec.ts';
import { emptyDocument } from './commands.ts';
import { assertFence } from './leadership.ts';
import type { Leadership } from './leadership.ts';
import { resolveAccess } from './access.ts';
import type { AccessRequest } from './access.ts';
import { CollaborationError } from './internal-server.ts';
export const digest = (bytes: Uint8Array | string) =>
  createHash('sha256').update(bytes).digest('hex');
export const receiptFor = (bytes: Uint8Array) => {
  const h = digest(bytes);
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`;
};
export interface StoredDocument {
  page_id: string;
  workspace_id: string;
  generation: string;
  snapshot: Buffer;
  snapshot_revision: string;
  content_revision: string;
  projection_revision: string;
  journal_bytes: string;
  encoded_bytes: number;
  business_bytes: number;
  history_warning_at: Date | null;
}
export interface Contribution {
  identity: AccessRequest;
  receipt: string;
  update: Uint8Array;
  requestHash?: string;
}
export type AccessResolver = typeof resolveAccess;
export class Store {
  constructor(
    readonly pool: Pool,
    readonly leadership: Leadership,
    readonly access: AccessResolver = resolveAccess,
  ) {}
  async transaction<T>(work: (client: PoolClient) => Promise<T>) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await assertFence(client, this.leadership.fence);
      const result = await work(client);
      await client.query('COMMIT');
      return result;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async authorize(identity: AccessRequest, client: Pool | PoolClient = this.pool) {
    const access = (await this.access(client, [identity])).get(identity.key);
    if (!access) throw new CollaborationError('ACCESS_DENIED', 403);
    return access;
  }
  async open(identity: AccessRequest) {
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM pages WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE', [
        identity.page,
        identity.workspace,
      ]);
      await this.authorize(identity, client);
      let row = (
        await client.query<StoredDocument>(
          'SELECT * FROM collaboration_documents WHERE page_id=$1',
          [identity.page],
        )
      ).rows[0];
      if (!row) {
        if (
          (await client.query('SELECT 1 FROM blocks WHERE page_id=$1 LIMIT 1', [identity.page]))
            .rowCount
        )
          throw new CollaborationError('DOCUMENT_RESET_REQUIRED');
        const doc = emptyDocument();
        try {
          const snapshot = Y.encodeStateAsUpdate(doc),
            business = Buffer.byteLength(JSON.stringify(decodeDocument(doc)));
          row = (
            await client.query<StoredDocument>(
              `INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes,content_revision,snapshot_revision,projection_due_at,projection_first_pending_at) VALUES($1,$2,$3,$4,$5,$6,1,1,clock_timestamp(),clock_timestamp()) RETURNING *`,
              [
                identity.page,
                identity.workspace,
                randomUUID(),
                Buffer.from(snapshot),
                snapshot.length,
                business,
              ],
            )
          ).rows[0]!;
        } finally {
          doc.destroy();
        }
      }
      return row;
    });
  }
  async load(page: string, generation: string) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      const state = (
        await client.query<StoredDocument>(
          'SELECT * FROM collaboration_documents WHERE page_id=$1 AND generation=$2',
          [page, generation],
        )
      ).rows[0];
      if (!state) throw new CollaborationError('GENERATION_CHANGED');
      const updates = (
        await client.query<{ update: Buffer }>(
          'SELECT update FROM collaboration_updates WHERE page_id=$1 AND generation=$2 AND revision>$3 AND revision<=$4 ORDER BY revision',
          [page, generation, state.snapshot_revision, state.content_revision],
        )
      ).rows;
      await client.query('COMMIT');
      return { state, snapshot: state.snapshot, updates: updates.map((u) => u.update) };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      client.release();
    }
  }
  async receipt(identity: AccessRequest, generation: string, receipt: string, requestHash: string) {
    const access = await this.authorize(identity);
    const row = (
      await this.pool.query<{ revision: string; request_hash: string }>(
        `SELECT revision,request_hash FROM collaboration_receipts WHERE page_id=$1 AND generation=$2 AND actor_id=$3 AND receipt=$4`,
        [identity.page, generation, access.actor, receipt],
      )
    ).rows[0];
    if (row && row.request_hash !== requestHash) throw new CollaborationError('RECEIPT_REUSED');
    return row ? Number(row.revision) : undefined;
  }
  async append(
    generation: string,
    expected: number,
    entries: Contribution[],
    merged: Uint8Array,
    images: BlockEnvelope[],
    blockIds: string[],
  ) {
    const { page, workspace } = entries[0]!.identity;
    return this.transaction(async (client) => {
      await client.query('SELECT id FROM pages WHERE id=$1 AND workspace_id=$2 FOR NO KEY UPDATE', [
        page,
        workspace,
      ]);
      const access = await this.access(
        client,
        entries.map((e) => e.identity),
      );
      for (const entry of entries)
        if (access.get(entry.identity.key)?.level !== 'edit')
          throw new CollaborationError('ACCESS_DENIED', 403);
      const state = (
        await client.query<StoredDocument>(
          'SELECT * FROM collaboration_documents WHERE page_id=$1 AND generation=$2',
          [page, generation],
        )
      ).rows[0];
      if (!state || Number(state.content_revision) !== expected)
        throw new CollaborationError('REVISION_CHANGED');
      const fileIds = [
        ...new Set(
          images.map((b) => b.content.fileId).filter((v): v is string => typeof v === 'string'),
        ),
      ];
      if (
        fileIds.length &&
        (
          await client.query(
            "SELECT id FROM files WHERE id=ANY($1::uuid[]) AND workspace_id=$2 AND deleted_at IS NULL AND state='ready'",
            [fileIds, workspace],
          )
        ).rowCount !== fileIds.length
      )
        throw new CollaborationError('FILE_ACCESS_DENIED', 403);
      await client.query(
        'INSERT INTO collaboration_block_ids(id,page_id) SELECT unnest($1::uuid[]),$2 ON CONFLICT(id) DO NOTHING',
        [blockIds, page],
      );
      if (
        (
          await client.query(
            'SELECT id FROM collaboration_block_ids WHERE id=ANY($1::uuid[]) AND page_id=$2',
            [blockIds, page],
          )
        ).rowCount !== blockIds.length
      )
        throw new CollaborationError('BLOCK_ID_CONFLICT');
      const next = expected + 1;
      await client.query(
        'INSERT INTO collaboration_updates(workspace_id,page_id,generation,revision,update) VALUES($1,$2,$3,$4,$5)',
        [workspace, page, generation, next, Buffer.from(merged)],
      );
      for (const entry of entries) {
        const old = (
          await client.query<{ revision: string; update_hash: string }>(
            `INSERT INTO collaboration_receipts(workspace_id,page_id,generation,actor_id,receipt,revision,update_hash,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(page_id,generation,actor_id,receipt) DO UPDATE SET receipt=EXCLUDED.receipt RETURNING revision,update_hash`,
            [
              workspace,
              page,
              generation,
              access.get(entry.identity.key)!.actor,
              entry.receipt,
              next,
              digest(entry.update),
              entry.requestHash ?? null,
            ],
          )
        ).rows[0]!;
        if (old.update_hash !== digest(entry.update))
          throw new CollaborationError('RECEIPT_REUSED');
      }
      await client.query(
        `UPDATE collaboration_documents SET content_revision=$2,journal_bytes=journal_bytes+$3,updated_at=clock_timestamp(),projection_first_pending_at=coalesce(projection_first_pending_at,clock_timestamp()),projection_due_at=least(clock_timestamp()+interval '1 second',coalesce(projection_first_pending_at,clock_timestamp())+interval '5 seconds') WHERE page_id=$1`,
        [page, next, merged.length],
      );
      return next;
    });
  }
}
