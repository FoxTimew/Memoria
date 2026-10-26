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
/** Drain every queued query before rollback/release, including after an early rejection. */
async function drainQueries<T extends unknown[]>(queries: { [K in keyof T]: Promise<T[K]> }) {
  const results = await Promise.allSettled(queries);
  for (const result of results) if (result.status === 'rejected') throw result.reason;
  return results.map((result) => (result as PromiseFulfilledResult<unknown>).value) as T;
}
export class Store {
  constructor(
    readonly pool: Pool,
    readonly leadership: Leadership,
    readonly access: AccessResolver = resolveAccess,
  ) {}
  async transaction<T>(
    work: (client: PoolClient) => Promise<T>,
    pageLock?: { page: string; workspace: string },
  ) {
    const client = await this.pool.connect();
    try {
      const fence = this.leadership.fence;
      // PostgreSQL executes this ordered pipeline serially. No data write precedes its checks.
      await drainQueries([
        client.query('BEGIN'),
        assertFence(client, fence),
        pageLock
          ? client.query('SELECT content_lock_document($2::uuid,$1::uuid)', [
              pageLock.page,
              pageLock.workspace,
            ])
          : Promise.resolve(),
      ]);
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
      await client.query('SELECT content_lock_document($2::uuid,$1::uuid)', [
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
    return this.transaction(
      async (client) => {
        // These reads start only AFTER the page lock. A waiting writer must see the new revision.
        const [access, revision] = await drainQueries([
          this.access(
            client,
            entries.map((e) => e.identity),
          ),
          client.query<StoredDocument>(
            'SELECT content_revision FROM collaboration_documents WHERE page_id=$1 AND generation=$2',
            [page, generation],
          ),
        ]);
        for (const entry of entries)
          if (access.get(entry.identity.key)?.level !== 'edit')
            throw new CollaborationError('ACCESS_DENIED', 403);
        const state = revision.rows[0];
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
        // A CTE sees the statement's snapshot: newly reserved IDs are obtained through RETURNING.
        // A concurrent conflicting owner remains absent from both sets and is rejected.
        const next = expected + 1;
        const hashes = entries.map((entry) => digest(entry.update));
        const [reserved, receipts] = await drainQueries([
          blockIds.length
            ? client.query<{ count: string }>({
                name: 'collaboration-reserve-block-ids-v1',
                text: `WITH reserved AS (
          INSERT INTO collaboration_block_ids(id,page_id)
          SELECT id,$2 FROM unnest($1::uuid[]) AS input(id)
          WHERE NOT EXISTS(SELECT 1 FROM collaboration_block_ids known WHERE known.id=input.id AND known.page_id=$2)
          ON CONFLICT(id) DO NOTHING RETURNING id
        ) SELECT count(*) AS count FROM (
          SELECT id FROM collaboration_block_ids WHERE id=ANY($1::uuid[]) AND page_id=$2
          UNION SELECT id FROM reserved
        ) valid`,
                values: [blockIds, page],
              })
            : Promise.resolve({ rows: [{ count: '0' }] }),
          drainQueries(
            entries.map((entry, index) =>
              client.query<{ revision: string; update_hash: string }>({
                name: 'collaboration-receipt-v1',
                text: `INSERT INTO collaboration_receipts(workspace_id,page_id,generation,actor_id,receipt,revision,update_hash,request_hash) VALUES($1,$2,$3,$4,$5,$6,$7,$8) ON CONFLICT(page_id,generation,actor_id,receipt) DO UPDATE SET receipt=EXCLUDED.receipt RETURNING revision,update_hash`,
                values: [
                  workspace,
                  page,
                  generation,
                  access.get(entry.identity.key)!.actor,
                  entry.receipt,
                  next,
                  hashes[index],
                  entry.requestHash ?? null,
                ],
              }),
            ),
          ),
        ]);
        if (Number(reserved.rows[0]!.count) !== blockIds.length)
          throw new CollaborationError('BLOCK_ID_CONFLICT');
        const revisions: number[] = [];
        for (const [index, receipt] of receipts.entries()) {
          const old = receipt.rows[0]!;
          if (old.update_hash !== hashes[index]) throw new CollaborationError('RECEIPT_REUSED');
          revisions.push(Number(old.revision));
        }
        if (revisions.every((r) => r !== next)) return { revision: expected, revisions };
        await client.query({
          name: 'collaboration-append-update-v1',
          text: `WITH journal AS (
          INSERT INTO collaboration_updates(workspace_id,page_id,generation,revision,update)
          VALUES($1,$2,$3,$4,$5) RETURNING page_id
        ) UPDATE collaboration_documents SET content_revision=$4,journal_bytes=journal_bytes+octet_length($5::bytea),updated_at=clock_timestamp(),projection_first_pending_at=coalesce(projection_first_pending_at,clock_timestamp()),projection_due_at=least(clock_timestamp()+interval '1 second',coalesce(projection_first_pending_at,clock_timestamp())+interval '5 seconds') WHERE page_id IN (SELECT page_id FROM journal)`,
          values: [workspace, page, generation, next, Buffer.from(merged)],
        });
        return { revision: next, revisions };
      },
      { page, workspace },
    );
  }
}
