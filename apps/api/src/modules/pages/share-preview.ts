import { createHmac } from 'node:crypto';
import { sql } from 'drizzle-orm';
import type { WriteTransaction } from '@memoria/db';
import { canonicalJson } from '@memoria/contracts';
import type { AccessPreview } from '@memoria/contracts';
import { readConfig } from '../../config.ts';
import type { StoredPage } from './content-access.ts';

type Grant = { member: string; page: string; level: 'read' | 'edit'; inherit: boolean };
/** Explanation only; the authoritative authorization remains content_resolve_access.
 * Tests compare the preview to that SQL resolver after the actual move. */
export function predictedLevel(
  page: StoredPage,
  all: StoredPage[],
  grants: Grant[],
  member: string,
) {
  return predictor(all, grants)(page.id, member);
}
function predictor(all: StoredPage[], grants: Grant[]) {
  const pages = new Map(all.map((p) => [p.id, p]));
  const paths = new Map<string, string[] | null>();
  const byMember = new Map<string, Map<string, Grant>>();
  for (const grant of grants) {
    if (!byMember.has(grant.member)) byMember.set(grant.member, new Map());
    byMember.get(grant.member)!.set(grant.page, grant);
  }
  for (const page of all) {
    const ancestors: string[] = [];
    let current: StoredPage | undefined = page;
    while (
      current &&
      !current.deletedAt &&
      !ancestors.includes(current.id) &&
      ancestors.length < 50
    ) {
      ancestors.push(current.id);
      if (!current.parentId) break;
      current = pages.get(current.parentId);
    }
    paths.set(
      page.id,
      current && !current.deletedAt && current.parentId === null ? ancestors : null,
    );
  }
  return (page: string, member: string): 'none' | 'read' | 'edit' => {
    const ancestors = paths.get(page),
      own = byMember.get(member);
    if (!ancestors || !own) return 'none';
    let level: 'none' | 'read' = 'none';
    for (const id of ancestors) {
      const grant = own.get(id);
      if (grant && (id === page || grant.inherit)) {
        if (grant.level === 'edit') return 'edit';
        level = 'read';
      }
    }
    return level;
  };
}
export async function shareState(tx: WriteTransaction, workspace: string) {
  const version = (
    await tx.execute<{ version: number }>(
      sql`SELECT access_version AS version FROM workspaces WHERE id=${workspace}::uuid`,
    )
  ).rows[0]!.version;
  const guests = (
    await tx.execute<{ member: string; name: string }>(
      sql`SELECT m.id AS member,u.name FROM workspace_members m JOIN auth_users u ON u.id=m.user_id WHERE m.workspace_id=${workspace}::uuid AND m.role='guest' ORDER BY m.id`,
    )
  ).rows;
  const grants = (
    await tx.execute<Grant>(
      sql`SELECT s.member_id AS member,g.resource_id AS page,g.level,g.inherit FROM access_subjects s JOIN access_grants g ON g.subject_id=s.id AND g.workspace_id=s.workspace_id WHERE s.workspace_id=${workspace}::uuid AND s.kind='member' AND s.deleted_at IS NULL AND g.deleted_at IS NULL AND g.resource_type='page' ORDER BY g.id`,
    )
  ).rows;
  return { version, guests, grants };
}
export async function accessPreview(
  tx: WriteTransaction,
  workspace: string,
  before: StoredPage[],
  after: StoredPage[],
  affected: Set<string>,
  binding: object,
): Promise<AccessPreview> {
  const state = await shareState(tx, workspace);
  const effects: AccessPreview['effects'] = [];
  const fromLevel = predictor(before, state.grants),
    toLevel = predictor(after, state.grants);
  for (const guest of state.guests) {
    const changes: AccessPreview['effects'][number]['changes'] = [];
    for (const old of before.filter((p) => affected.has(p.id))) {
      const from = fromLevel(old.id, guest.member);
      const to = toLevel(old.id, guest.member);
      if (from === to) continue;
      const existing = changes.find((c) => c.from === from && c.to === to);
      if (existing) existing.count++;
      else changes.push({ from, to, count: 1 });
    }
    if (changes.length) effects.push({ memberId: guest.member, name: guest.name, changes });
  }
  const token = createHmac('sha256', readConfig().BETTER_AUTH_SECRET)
    .update(canonicalJson({ workspace, version: state.version, binding, effects }))
    .digest('hex');
  return { token, accessVersion: state.version, pages: affected.size, effects };
}
