'use client';
import { useEffect, useState } from 'react';
import type { ReactNode } from 'react';
import { retireLegacyDrafts } from '../lib/yjs-cache.ts';
import { CachePolicyMonitor } from './cache-policy-monitor.tsx';

export function LocalDataBoundary({ children }: { children: ReactNode }) {
  const [ready, setReady] = useState(false),
    [error, setError] = useState(''),
    [attempt, setAttempt] = useState(0);
  useEffect(() => {
    let active = true;
    void retireLegacyDrafts()
      .then(() => {
        if (active) setReady(true);
      })
      .catch((e: unknown) => {
        if (active)
          setError(e instanceof Error ? e.message : 'Nettoyage des anciens brouillons impossible.');
      });
    return () => {
      active = false;
    };
  }, [attempt]);
  if (ready)
    return (
      <>
        <CachePolicyMonitor />
        {children}
      </>
    );
  return (
    <main className="p-8" aria-busy={!error}>
      <p role={error ? 'alert' : 'status'}>{error || 'Préparation du stockage local…'}</p>
      {error && (
        <button
          className="primary mt-4"
          onClick={() => {
            setError('');
            setAttempt((n) => n + 1);
          }}
        >
          Réessayer
        </button>
      )}
    </main>
  );
}
