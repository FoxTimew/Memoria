import type { Pool } from 'pg';
/** One durable row window per transaction. No claim disappears if this worker crashes. */
export async function processDatabaseRowEvent(pool: Pool) {
  const candidate = (
    await pool.query<{ workspace_id: string; database_id: string; row_page_id: string }>(
      `SELECT workspace_id,database_id,row_page_id FROM database_row_changes r WHERE first_dirty_at IS NOT NULL AND least(last_dirty_at+interval '1 second',first_dirty_at+interval '5 seconds')<=clock_timestamp() AND NOT EXISTS(SELECT 1 FROM collaboration_documents d WHERE d.workspace_id=r.workspace_id AND d.page_id=r.row_page_id AND d.content_revision>d.projection_revision) ORDER BY first_dirty_at LIMIT 1`,
    )
  ).rows[0];
  if (!candidate) return false;
  const { workspace_id: w, database_id: b, row_page_id: r } = candidate,
    c = await pool.connect();
  try {
    await c.query('BEGIN');
    await c.query("SET LOCAL lock_timeout='2s'");
    // Same order as writers: base, lifecycle, then the revision/window row.
    await c.query('SELECT id FROM databases WHERE workspace_id=$1 AND id=$2 FOR SHARE', [w, b]);
    await c.query(
      'SELECT page_id FROM database_rows WHERE workspace_id=$1 AND page_id=$2 FOR SHARE',
      [w, r],
    );
    const state = (
      await c.query<{ property_revision: string; event_revision: string }>(
        `SELECT property_revision::text,event_revision::text FROM database_row_changes WHERE workspace_id=$1 AND row_page_id=$2 AND first_dirty_at IS NOT NULL AND least(last_dirty_at+interval '1 second',first_dirty_at+interval '5 seconds')<=clock_timestamp() FOR UPDATE SKIP LOCKED`,
        [w, r],
      )
    ).rows[0];
    if (!state) {
      await c.query('COMMIT');
      return false;
    }
    // A pending body projection joins this same window. Its retry must not emit a stale body event.
    if (
      (
        await c.query(
          'SELECT 1 FROM collaboration_documents WHERE workspace_id=$1 AND page_id=$2 AND content_revision>projection_revision',
          [w, r],
        )
      ).rowCount
    ) {
      await c.query('COMMIT');
      return false;
    }
    const revision = (BigInt(state.event_revision) + 1n).toString();
    const content =
      (
        await c.query<{ projection_revision: string }>(
          'SELECT projection_revision::text FROM collaboration_documents WHERE workspace_id=$1 AND page_id=$2',
          [w, r],
        )
      ).rows[0]?.projection_revision ?? '0';
    const archived =
      (
        await c.query<{ archived: boolean }>(
          'SELECT deleted_at IS NOT NULL AS archived FROM pages WHERE workspace_id=$1 AND id=$2',
          [w, r],
        )
      ).rows[0]?.archived ?? true;
    await c.query(
      `INSERT INTO outbox_events(workspace_id,type,aggregate_id,aggregate_version,payload) VALUES($1,'database.row.updated',$2,$3,$4)`,
      [
        w,
        r,
        revision,
        {
          workspaceId: w,
          databaseId: b,
          rowId: r,
          eventRevision: revision,
          propertyRevision: state.property_revision,
          contentRevision: content,
          archived,
        },
      ],
    );
    await c.query(
      `INSERT INTO audit_logs(workspace_id,actor_id,action,resource_type,resource_id,metadata) SELECT workspace_id,actor_id,'database.row.updated','database_row',row_page_id,$3 FROM database_row_authors WHERE workspace_id=$1 AND row_page_id=$2`,
      [
        w,
        r,
        {
          eventRevision: revision,
          propertyRevision: state.property_revision,
          contentRevision: content,
        },
      ],
    );
    await c.query('DELETE FROM database_row_authors WHERE workspace_id=$1 AND row_page_id=$2', [
      w,
      r,
    ]);
    await c.query(
      'UPDATE database_row_changes SET event_revision=$3,first_dirty_at=NULL,last_dirty_at=NULL WHERE workspace_id=$1 AND row_page_id=$2',
      [w, r, revision],
    );
    await c.query('COMMIT');
    return true;
  } catch (e) {
    await c.query('ROLLBACK');
    throw e;
  } finally {
    c.release();
  }
}
