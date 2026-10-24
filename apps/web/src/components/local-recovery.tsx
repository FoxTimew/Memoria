'use client';
import { useState } from 'react';
import * as Y from 'yjs';
import { yjsCache } from '../lib/yjs-cache.ts';
import type { CachePage, CacheTicket } from '../lib/yjs-cache.ts';

export function LocalRecovery({ ticket, pages }: { ticket: CacheTicket; pages: CachePage[] }) {
  const [remaining, setRemaining] = useState(pages),
    [error, setError] = useState('');
  if (!remaining.length) return null;
  async function act(page: CachePage, remove: boolean) {
    try {
      if (remove) {
        await yjsCache.discard(ticket, page);
        setRemaining((list) => list.filter((p) => p.key !== page.key));
      } else {
        const cached = await yjsCache.open(ticket, page.workspace, page.page, page.generation);
        const bytes = Y.mergeUpdates(cached.updates);
        const url = URL.createObjectURL(
          new Blob([Uint8Array.from(bytes)], { type: 'application/octet-stream' }),
        );
        const anchor = document.createElement('a');
        anchor.href = url;
        anchor.download = `memoria-${page.page}-${page.generation}.yjs`;
        anchor.click();
        URL.revokeObjectURL(url);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Copie locale inaccessible.');
    }
  }
  return (
    <section className="notice m-6" aria-label="Ancienne copie locale">
      <p>
        Cette page a été réinitialisée sur le serveur. Son ancienne copie locale n’a pas été
        fusionnée. Vous pouvez télécharger une copie Yjs de secours avant de l’abandonner.
      </p>
      {remaining.map((page, i) => (
        <div key={page.key} className="mt-3 flex gap-4">
          <span>Copie {i + 1}</span>
          <button className="quiet-link" onClick={() => void act(page, false)}>
            Télécharger la copie
          </button>
          <button className="quiet-link" onClick={() => void act(page, true)}>
            Abandonner cette copie
          </button>
        </div>
      ))}
      {error && <p role="alert">{error}</p>}
    </section>
  );
}
