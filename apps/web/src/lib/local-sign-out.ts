import { logoutMarkerKey, retireLegacyDrafts, yjsCache } from './yjs-cache.ts';
import { clearAccessFlows } from './access-flow.ts';
const eventName = 'memoria-local-sign-out';
export function notifyLocalSignOut(user: string) {
  clearAccessFlows();
  // Opaque revocation marker only. No page content, names or authentication token.
  try {
    globalThis.localStorage?.setItem(logoutMarkerKey(user), crypto.randomUUID());
  } catch {
    /* IDB fencing remains authoritative. */
  }
  globalThis.dispatchEvent(new CustomEvent(eventName, { detail: user }));
  for (const name of [eventName, 'memoria-drafts-cleared']) {
    if (typeof BroadcastChannel !== 'undefined') {
      const channel = new BroadcastChannel(name);
      channel.postMessage(user);
      channel.close();
    }
  }
}
export function onLocalSignOut(user: string, callback: () => void) {
  const local = (event: Event) => {
    if ((event as CustomEvent).detail === user) {
      clearAccessFlows();
      callback();
    }
  };
  const storage = (event: StorageEvent) => {
    if (event.key === logoutMarkerKey(user)) {
      clearAccessFlows();
      callback();
    }
  };
  globalThis.addEventListener(eventName, local);
  globalThis.addEventListener('storage', storage);
  const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(eventName) : undefined;
  if (channel)
    channel.onmessage = (e: MessageEvent<unknown>) => {
      if (e.data === user) {
        clearAccessFlows();
        callback();
      }
    };
  return () => {
    globalThis.removeEventListener(eventName, local);
    globalThis.removeEventListener('storage', storage);
    channel?.close();
  };
}
/** Attempt server revocation even if local storage is unavailable; report each result honestly. */
export async function signOutAndClear(
  user: string,
  session: string,
  remote: () => Promise<void>,
  clear: () => Promise<void> = async () => {
    const results = await Promise.allSettled([
      retireLegacyDrafts(),
      yjsCache.clearUser(user, session),
    ]);
    for (const result of results) if (result.status === 'rejected') throw result.reason;
  },
  notify = () => notifyLocalSignOut(user),
) {
  try {
    notify();
  } catch {
    /* Still attempt both revocation and erasure. */
  }
  const [local, server] = await Promise.allSettled([clear(), remote()]);
  return {
    cacheCleared: local.status === 'fulfilled',
    serverSignedOut: server.status === 'fulfilled',
  };
}
