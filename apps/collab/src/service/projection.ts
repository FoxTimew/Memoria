import { randomUUID } from 'node:crypto';
import { createBlockRegistry } from '@memoria/block-catalog/server';
import { IncrementalValidator } from './incremental-validator.ts';
import type { ValidationPool } from './validation-pool.ts';
import type { Store } from './store.ts';
import { CollaborationError } from './internal-server.ts';

/** Durable scheduling lives in PostgreSQL; this singleton is only a polling executor. */
export class Projections {
  private stopped = false;
  private timer: ReturnType<typeof setTimeout> | undefined;
  private running: Promise<void> | undefined;
  private tail: Promise<unknown> = Promise.resolve();
  constructor(
    readonly store: Store,
    readonly report: (event: object) => void = (event) => console.warn(JSON.stringify(event)),
    private readonly validators?: ValidationPool,
  ) {}
  start() {
    this.schedule();
  }
  private schedule() {
    if (!this.stopped)
      this.timer = setTimeout(() => {
        this.running = this.tick()
          .catch(() => this.report({ event: 'collaboration.scheduler.failed' }))
          .finally(() => {
            this.running = undefined;
            this.schedule();
          });
      }, 100);
  }
  async tick() {
    const rows = (
      await this.store.pool.query<{ page_id: string; generation: string }>(
        `SELECT page_id,generation FROM collaboration_documents WHERE (projection_retry_at IS NULL OR projection_retry_at<=clock_timestamp()) AND (projection_due_at<=clock_timestamp() OR (content_revision>snapshot_revision AND (journal_bytes>=1048576 OR content_revision-snapshot_revision>=500 OR compacted_at<clock_timestamp()-interval '5 minutes'))) ORDER BY projection_due_at NULLS LAST LIMIT 1`,
      )
    ).rows;
    for (const row of rows) {
      try {
        await this.project(row.page_id, row.generation);
      } catch {
        await this.store.transaction(async (client) => {
          await client.query(
            `UPDATE collaboration_documents SET projection_attempts=projection_attempts+1,projection_retry_at=clock_timestamp()+(least(30,power(2,least(projection_attempts,5))*(1+random()*0.2)) * interval '1 second') WHERE page_id=$1 AND generation=$2`,
            [row.page_id, row.generation],
          );
        });
        this.report({ event: 'collaboration.projection.failed', page: row.page_id });
      }
    }
  }
  project(page: string, generation: string) {
    const result = this.tail.then(() => this.projectOne(page, generation));
    this.tail = result.catch(() => {});
    return result;
  }
  private async projectOne(page: string, generation: string) {
    const loaded = await this.store.load(page, generation),
      state = loaded.state;
    const target = Number(state.content_revision);
    const replica = new IncrementalValidator(this.validators, () => {}, 128 * 1024 ** 2);
    let snapshot: Uint8Array, blocks: Awaited<ReturnType<IncrementalValidator['inspect']>>;
    try {
      await replica.init(loaded.snapshot, loaded.updates);
      blocks = await replica.inspect();
      snapshot = await replica.snapshot();
    } finally {
      await replica.close();
    }
    const business = Buffer.byteLength(JSON.stringify(blocks));
    await this.store.transaction(
      async (client) => {
        const databaseRow = (
          await client.query<{ database_id: string }>(
            'SELECT database_id FROM database_rows WHERE workspace_id=$1 AND page_id=$2',
            [state.workspace_id, page],
          )
        ).rows[0];
        // Base/row latch and projection mutex were acquired before the fence.
        const current = (
          await client.query<{ projection_revision: string }>(
            `SELECT projection_revision FROM collaboration_documents WHERE page_id=$1 AND generation=$2`,
            [page, generation],
          )
        ).rows[0];
        if (!current) return;
        const previous = Number(current.projection_revision);
        if (target > previous) {
          const authors = (
            await client.query<{ actor_id: string }>(
              `SELECT DISTINCT actor_id FROM collaboration_receipts WHERE page_id=$1 AND generation=$2 AND revision>$3 AND revision<=$4`,
              [page, generation, previous, target],
            )
          ).rows;
          const event = randomUUID();
          await client.query(
            `INSERT INTO collaboration_projection_commits(workspace_id,page_id,generation,revision,event_id,details) VALUES($1,$2,$3,$4,$5,$6)`,
            [
              state.workspace_id,
              page,
              generation,
              target,
              event,
              JSON.stringify({ authors: authors.length }),
            ],
          );
          // This is the only production writer of the block projection.
          await client.query('DELETE FROM file_references WHERE page_id=$1', [page]);
          await client.query('DELETE FROM blocks WHERE page_id=$1', [page]);
          for (const block of blocks) {
            await client.query(
              'INSERT INTO blocks(id,workspace_id,page_id,parent_id,position,type,schema_version,content) VALUES($1,$2,$3,$4,$5,$6,$7,$8)',
              [
                block.id,
                state.workspace_id,
                page,
                block.parentId,
                block.position,
                block.type,
                block.schemaVersion,
                JSON.stringify(block.content),
              ],
            );
            if (block.type === 'core.image' && block.content.fileId)
              await client.query(
                'INSERT INTO file_references(workspace_id,page_id,block_id,file_id) VALUES($1,$2,$3,$4)',
                [state.workspace_id, page, block.id, block.content.fileId],
              );
          }
          const row = (
            await client.query<{ title: string; version: string; visible: boolean }>(
              `WITH RECURSIVE ancestors AS (SELECT id,parent_id,deleted_at FROM pages WHERE id=$1 UNION ALL SELECT p.id,p.parent_id,p.deleted_at FROM pages p JOIN ancestors a ON p.id=a.parent_id) SELECT title,version,NOT EXISTS(SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL) AS visible FROM pages WHERE id=$1`,
              [page],
            )
          ).rows[0]!;
          if (databaseRow) {
            const registry = createBlockRegistry();
            const text = blocks.map((b) => registry.toPlainText(b)).join('\n');
            for (const author of authors)
              await client.query('SELECT database_mark_row($1,$2,$3,$4,false)', [
                state.workspace_id,
                databaseRow.database_id,
                page,
                author.actor_id,
              ]);
            if (!authors.length)
              await client.query('SELECT database_mark_row($1,$2,$3,NULL,false)', [
                state.workspace_id,
                databaseRow.database_id,
                page,
              ]);
            // Same lock order as cell/title writes: revision/window before search row.
            // The Yjs projection has already waited its 1s/5s window. Do not add a second one.
            await client.query(
              "UPDATE database_row_changes SET last_dirty_at=least(last_dirty_at,clock_timestamp()-interval '1 second') WHERE workspace_id=$1 AND row_page_id=$2",
              [state.workspace_id, page],
            );
            await client.query(
              'INSERT INTO database_row_search(workspace_id,database_id,row_page_id,body_text) VALUES($1,$2,$3,$4) ON CONFLICT(workspace_id,row_page_id) DO UPDATE SET body_text=excluded.body_text',
              [state.workspace_id, databaseRow.database_id, page, text],
            );
          } else if (row.visible) {
            const registry = createBlockRegistry();
            const text = [row.title, ...blocks.map((b) => registry.toPlainText(b))].join('\n');
            await client.query(
              `INSERT INTO search_documents(workspace_id,page_id,plain_text,page_version) VALUES($1,$2,$3,$4) ON CONFLICT(page_id) DO UPDATE SET plain_text=EXCLUDED.plain_text,page_version=EXCLUDED.page_version,updated_at=clock_timestamp()`,
              [state.workspace_id, page, text, row.version],
            );
          } else await client.query('DELETE FROM search_documents WHERE page_id=$1', [page]);
          if (!databaseRow)
            for (const author of authors)
              await client.query(
                `INSERT INTO audit_logs(workspace_id,actor_id,action,resource_type,resource_id,metadata) VALUES($1,$2,'collaboration.projected','page',$3,$4)`,
                [
                  state.workspace_id,
                  author.actor_id,
                  page,
                  JSON.stringify({ generation, contentRevision: target }),
                ],
              );
          if (!databaseRow)
            await client.query(
              `INSERT INTO outbox_events(id,workspace_id,type,aggregate_id,aggregate_version,payload) VALUES($1,$2,'page.updated',$3,$4,$5)`,
              [
                event,
                state.workspace_id,
                page,
                target,
                JSON.stringify({
                  id: event,
                  workspaceId: state.workspace_id,
                  type: 'page.updated',
                  schemaVersion: 1,
                  occurredAt: new Date().toISOString(),
                  data: { pageId: page, generation, contentRevision: target },
                }),
              ],
            );
        }
        const warn = snapshot.length >= 768 * 1024 && snapshot.length / business >= 4;
        const updated = await client.query(
          `UPDATE collaboration_documents SET projection_revision=greatest(projection_revision,$3),projection_attempts=0,projection_retry_at=NULL,projection_due_at=CASE WHEN content_revision<=$3 THEN NULL ELSE projection_due_at END,projection_first_pending_at=CASE WHEN content_revision<=$3 THEN NULL ELSE projection_first_pending_at END,encoded_bytes=CASE WHEN metrics_revision<=$3 THEN $4 ELSE encoded_bytes END,business_bytes=CASE WHEN metrics_revision<=$3 THEN $5 ELSE business_bytes END,metrics_revision=greatest(metrics_revision,$3),history_warning_at=CASE WHEN $6 AND history_warning_at IS NULL THEN clock_timestamp() ELSE history_warning_at END WHERE page_id=$1 AND generation=$2 RETURNING history_warning_at`,
          [page, generation, target, snapshot.length, business, warn],
        );
        if (warn && !state.history_warning_at && updated.rowCount)
          this.report({
            event: 'collaboration.history.warning',
            page,
            generation,
            revision: target,
            encodedBytes: snapshot.length,
            businessBytes: business,
            ratio: snapshot.length / business,
          });
        // Snapshot and pruning are atomic; receipts and effect markers remain durable.
        await client.query(
          `UPDATE collaboration_documents SET snapshot=$3,snapshot_revision=$4,journal_bytes=(SELECT coalesce(sum(octet_length(update)),0) FROM collaboration_updates WHERE page_id=$1 AND generation=$2 AND revision>$4),compacted_at=clock_timestamp() WHERE page_id=$1 AND generation=$2 AND snapshot_revision<$4`,
          [page, generation, Buffer.from(snapshot), target],
        );
        await client.query(
          'DELETE FROM collaboration_updates WHERE page_id=$1 AND generation=$2 AND revision<=$3',
          [page, generation, target],
        );
      },
      { page, workspace: state.workspace_id, mode: 'projection' },
    );
  }
  async wait(page: string, generation: string, revision: number, receipt: string, timeout = 15000) {
    const end = Date.now() + timeout;
    while (Date.now() < end && !this.stopped) {
      const row = (
        await this.store.pool.query<{ projection_revision: string }>(
          'SELECT projection_revision FROM collaboration_documents WHERE page_id=$1 AND generation=$2',
          [page, generation],
        )
      ).rows[0];
      if (!row) throw new CollaborationError('GENERATION_CHANGED');
      if (Number(row.projection_revision) >= revision) return;
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    throw new CollaborationError('PROJECTION_PENDING', 503, {
      receipt,
      contentRevision: revision,
      durable: true,
    });
  }
  async close() {
    this.stopped = true;
    clearTimeout(this.timer);
    await this.running;
    await this.tail;
  }
}
