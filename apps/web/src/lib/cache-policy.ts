import { cachePolicySchema, pageAccessSnapshotSchema } from '@memoria/contracts';
import { CacheForbidden, LocalSessionRevoked, yjsCache } from './yjs-cache.ts';
import type { CacheTicket } from './yjs-cache.ts';

export const cachePolicyEvent = 'memoria-cache-policy';
export function notifyCachePolicy(user: string) {
  globalThis.dispatchEvent(new CustomEvent(cachePolicyEvent, { detail: user }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(cachePolicyEvent);
    channel.postMessage(user);
    channel.close();
  }
}
export async function refreshCachePolicy(
  user: string,
  session: string,
  forceWorkspace?: string,
): Promise<CacheTicket> {
  const ticket = await yjsCache.ticket(user, session);
  const response = await fetch('/api/auth/security/cache-policy', {
    credentials: 'include',
    cache: 'no-store',
    signal: AbortSignal.timeout(4000),
  });
  if (response.status === 401 || response.status === 403) throw new LocalSessionRevoked();
  if (!response.ok)
    throw new Error('Vérification du stockage local indisponible. Réessayez en ligne.');
  const snapshot = cachePolicySchema.parse(await response.json());
  try {
    let current = await yjsCache.applyPolicy(ticket, snapshot);
    for (const workspace of snapshot.workspaces) {
      if (
        workspace.workspace !== forceWorkspace &&
        current.checkedAccessVersions[workspace.workspace] ===
          current.accessVersions[workspace.workspace]
      )
        continue;
      const response = await fetch(
        `/api/internal/workspaces/${encodeURIComponent(workspace.workspace)}/page-access`,
        {
          credentials: 'include',
          cache: 'no-store',
          signal: AbortSignal.timeout(4000),
        },
      );
      if ([401, 403, 404].includes(response.status)) {
        await yjsCache.revokeWorkspace(current, workspace.workspace);
        continue;
      }
      if (!response.ok) throw new Error('Vérification des pages indisponible. Réessayez en ligne.');
      current = await yjsCache.applyPageAccess(
        current,
        workspace.workspace,
        pageAccessSnapshotSchema.parse(await response.json()),
      );
    }
    return current;
  } finally {
    notifyCachePolicy(user);
  }
}
export { CacheForbidden };
