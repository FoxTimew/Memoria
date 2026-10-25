import type { Pool, PoolClient } from 'pg';
export interface PageAccessRequest {
  key: string;
  user: string;
  session: string;
  workspace: string;
  page: string;
}
export interface PageAccess extends PageAccessRequest {
  actor: string;
  level: 'read' | 'edit';
}
export function accessRequests(requests: readonly PageAccessRequest[]) {
  const unique = new Map<string, PageAccessRequest>();
  for (const r of requests) {
    const previous = unique.get(r.key);
    if (
      previous &&
      (previous.user !== r.user ||
        previous.session !== r.session ||
        previous.workspace !== r.workspace ||
        previous.page !== r.page)
    )
      throw new Error('Conflicting access request key');
    unique.set(r.key, r);
  }
  // Several queued contributions from one socket carry the same key and decision.
  return JSON.stringify(
    [...unique.values()].map((r) => ({
      key: r.key,
      userid: r.user,
      session: r.session,
      workspace: r.workspace,
      page: r.page,
    })),
  );
}
/** A new SQL statement observes revocations committed while waiting for the page lock. */
export async function resolvePageAccess(
  database: Pool | PoolClient,
  requests: readonly PageAccessRequest[],
): Promise<Map<string, PageAccess>> {
  if (!requests.length) return new Map();
  const result = await database.query<{ key: string; actor: string; level: 'read' | 'edit' }>({
    name: 'content-resolve-access-v1',
    text: 'SELECT key,actor,level FROM content_resolve_access($1::jsonb)',
    values: [accessRequests(requests)],
  });
  const byKey = new Map(requests.map((r) => [r.key, r]));
  return new Map(
    result.rows.map((r) => [r.key, { ...byKey.get(r.key)!, actor: r.actor, level: r.level }]),
  );
}
