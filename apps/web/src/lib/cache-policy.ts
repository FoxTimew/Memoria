import { cachePolicySchema } from '@memoria/contracts';
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
export async function refreshCachePolicy(user: string, session: string): Promise<CacheTicket> {
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
    return await yjsCache.applyPolicy(ticket, snapshot);
  } finally {
    notifyCachePolicy(user);
  }
}
export { CacheForbidden };
