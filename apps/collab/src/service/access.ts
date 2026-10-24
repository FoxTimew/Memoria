import type { Pool, PoolClient } from 'pg';
export interface AccessRequest {
  key: string;
  user: string;
  session: string;
  workspace: string;
  page: string;
}
export interface Access extends AccessRequest {
  actor: string;
  level: 'read' | 'edit';
}
/** Future guest resolver can return read; current SQL only admits verified owner/member sessions. */
export async function resolveAccess(
  database: Pool | PoolClient,
  requests: readonly AccessRequest[],
): Promise<Map<string, Access>> {
  if (!requests.length) return new Map();
  const result = await database.query<{ key: string; actor: string }>(
    `WITH RECURSIVE candidates AS (
 SELECT * FROM jsonb_to_recordset($1::jsonb) AS c(key text,userid uuid,session uuid,workspace uuid,page uuid)
 ), ancestors AS (
 SELECT c.key,p.id,p.parent_id,p.deleted_at,p.workspace_id,1 AS depth FROM candidates c JOIN pages p ON p.id=c.page AND p.workspace_id=c.workspace
 UNION ALL SELECT a.key,p.id,p.parent_id,p.deleted_at,p.workspace_id,a.depth+1 FROM ancestors a JOIN pages p ON p.id=a.parent_id AND p.workspace_id=a.workspace_id WHERE a.depth<51
 ) SELECT c.key,actor.id AS actor FROM candidates c
 JOIN auth_sessions s ON s.id=c.session AND s.user_id=c.userid JOIN auth_users u ON u.id=s.user_id
 JOIN workspaces w ON w.id=c.workspace AND w.deleted_at IS NULL
 JOIN LATERAL(SELECT id FROM actors WHERE workspace_id=c.workspace AND user_id=c.userid AND kind='user' ORDER BY created_at,id LIMIT 1) actor ON true
 WHERE s.expires_at>clock_timestamp() AND u.email_verified AND EXISTS(SELECT 1 FROM workspace_members m WHERE m.workspace_id=c.workspace AND m.user_id=c.userid AND m.role IN ('owner','member'))
 AND EXISTS(SELECT 1 FROM ancestors a WHERE a.key=c.key) AND NOT EXISTS(SELECT 1 FROM ancestors a WHERE a.key=c.key AND (a.deleted_at IS NOT NULL OR a.depth>50))`,
    [
      JSON.stringify(
        requests.map((r) => ({
          key: r.key,
          userid: r.user,
          session: r.session,
          workspace: r.workspace,
          page: r.page,
        })),
      ),
    ],
  );
  const byKey = new Map(requests.map((r) => [r.key, r]));
  return new Map(
    result.rows.map((r) => [
      r.key,
      { ...byKey.get(r.key)!, actor: r.actor, level: 'edit' as const },
    ]),
  );
}
