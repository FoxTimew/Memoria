'use client';
import { useEffect, useState } from 'react';
import { authClient } from '../lib/auth-client.ts';
import { refreshCachePolicy } from '../lib/cache-policy.ts';
import { CacheForbidden, LocalSessionRevoked } from '../lib/yjs-cache.ts';

/** Runs even without an open editor, to purge cached pages of other workspaces. */
export function CachePolicyMonitor() {
  const { data } = authClient.useSession();
  const [error, setError] = useState('');
  useEffect(() => {
    if (!data) return;
    let active = true,
      running = false;
    const check = async () => {
      if (running || !navigator.onLine) return;
      running = true;
      try {
        await refreshCachePolicy(data.user.id, data.session.id);
        if (active) setError('');
      } catch (e) {
        if (active && !(e instanceof CacheForbidden) && !(e instanceof LocalSessionRevoked))
          setError(
            'La politique de copie locale ne peut pas être vérifiée. Gardez cet onglet ouvert et réessayez en ligne.',
          );
      } finally {
        running = false;
      }
    };
    void check();
    const timer = setInterval(() => void check(), 4000);
    for (const event of ['focus', 'pageshow', 'online', 'visibilitychange'])
      window.addEventListener(event, check);
    return () => {
      active = false;
      clearInterval(timer);
      for (const event of ['focus', 'pageshow', 'online', 'visibilitychange'])
        window.removeEventListener(event, check);
    };
  }, [data?.user.id, data?.session.id]);
  return error ? (
    <p role="alert" className="notice error">
      {error}
    </p>
  ) : null;
}
