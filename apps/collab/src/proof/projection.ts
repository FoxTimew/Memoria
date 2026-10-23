// Isolated SQL fixture projection. The production BlockWriteService is deliberately unchanged.
import * as Y from 'yjs';
import type { Pool } from 'pg';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import { decodeDocument } from '../codec.ts';

export class ProofProjector {
  private idle: ReturnType<typeof setTimeout> | undefined;
  private maximum: ReturnType<typeof setTimeout> | undefined;
  private retry: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private stopped = false;
  fail = false;
  incidents = 0;
  revision = 0;
  private retries = 0;
  constructor(
    private readonly pool: Pool,
    private readonly workspace: string,
    private readonly page: string,
  ) {}
  changed() {
    if (this.stopped) return;
    clearTimeout(this.idle);
    this.idle = setTimeout(() => {
      void this.flush();
    }, 1000);
    this.maximum ??= setTimeout(() => {
      void this.flush();
    }, 5000);
  }
  async flush() {
    if (this.running || this.stopped) return this.running;
    clearTimeout(this.idle);
    clearTimeout(this.maximum);
    clearTimeout(this.retry);
    this.idle = this.maximum = this.retry = undefined;
    this.running = this.project()
      .catch(() => {
        this.incidents++;
        console.log('Projection incident (injected or SQL); content journal remains writable');
        const backoff = Math.min(30_000, 1000 * 2 ** this.retries++);
        this.retry = setTimeout(() => {
          void this.flush();
        }, backoff);
      })
      .finally(() => {
        this.running = undefined;
      });
    await this.running;
  }
  private async project() {
    const client = await this.pool.connect();
    const doc = new Y.Doc();
    doc.getXmlFragment('prosemirror');
    try {
      // Consistent view of snapshot+journal, independent of the room and its write transaction.
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      const state = (
        await client.query<{
          snapshot: Buffer;
          snapshot_revision: string;
          content_revision: string;
          projection_revision: string;
        }>('SELECT * FROM collaboration_documents WHERE page_id=$1', [this.page])
      ).rows[0]!;
      const target = Number(state.content_revision),
        previous = Number(state.projection_revision);
      if (target === previous) {
        await client.query('COMMIT');
        this.revision = previous;
        return;
      }
      Y.applyUpdate(doc, state.snapshot);
      const updates = await client.query<{ update: Buffer; revision: string; author_id: string }>(
        'SELECT update,revision,author_id FROM collaboration_updates WHERE page_id=$1 AND revision>$2 AND revision<=$3 ORDER BY revision',
        [this.page, state.snapshot_revision, target],
      );
      for (const row of updates.rows) Y.applyUpdate(doc, row.update);
      const blocks = decodeDocument(doc);
      const authors = (
        await client.query<{ author_id: string }>(
          'SELECT DISTINCT author_id FROM collaboration_receipts WHERE page_id=$1 AND revision>$2 AND revision<=$3',
          [this.page, previous, target],
        )
      ).rows;
      await client.query('COMMIT');
      await client.query('BEGIN');
      // Single projector per page; no room lock and no workspace lock.
      await client.query('DELETE FROM file_references WHERE page_id=$1', [this.page]);
      await client.query('DELETE FROM blocks WHERE page_id=$1', [this.page]);
      for (const block of blocks) {
        await client.query(
          'INSERT INTO blocks(id,workspace_id,page_id,parent_id,position,type,schema_version,content) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)',
          [
            block.id,
            this.workspace,
            this.page,
            block.parentId,
            block.position,
            block.type,
            block.schemaVersion,
            JSON.stringify(block.content),
          ],
        );
        if (block.type === 'core.image' && block.content.fileId)
          await client.query(
            'INSERT INTO file_references(workspace_id,page_id,block_id,file_id) VALUES ($1,$2,$3,$4)',
            [this.workspace, this.page, block.id, block.content.fileId],
          );
      }
      const registry = createBlockRegistry();
      const text = blocks.map((block) => registry.toPlainText(block)).join('\n');
      await client.query(
        'INSERT INTO search_documents(workspace_id,page_id,plain_text,page_version) VALUES ($1,$2,$3,$4) ON CONFLICT(page_id) DO UPDATE SET plain_text=EXCLUDED.plain_text,page_version=EXCLUDED.page_version',
        [this.workspace, this.page, text, target],
      );
      for (const author of authors)
        await client.query(
          "INSERT INTO audit_logs(workspace_id,actor_id,action,resource_type,resource_id,metadata) SELECT $1,id,'collaboration.projected','page',$2,$3 FROM actors WHERE workspace_id=$1 AND user_id=$4",
          [
            this.workspace,
            this.page,
            JSON.stringify({ contentRevision: target }),
            author.author_id,
          ],
        );
      await client.query(
        "INSERT INTO outbox_events(workspace_id,type,aggregate_id,aggregate_version,payload) VALUES ($1,'page.updated',$2,$3,$4)",
        [this.workspace, this.page, target, JSON.stringify({ contentRevision: target })],
      );
      // Fail after effects to prove atomic rollback, not just an early return.
      if (this.fail) await client.query('SELECT 1 / 0');
      await client.query(
        'UPDATE collaboration_documents SET projection_revision=$2 WHERE page_id=$1',
        [this.page, target],
      );
      await client.query('COMMIT');
      this.revision = target;
      this.retries = 0;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally {
      doc.destroy();
      client.release();
    }
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.idle);
    clearTimeout(this.maximum);
    clearTimeout(this.retry);
    await this.running;
    clearTimeout(this.retry);
  }
}
