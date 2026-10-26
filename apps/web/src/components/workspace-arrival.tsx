'use client';
import { useEffect, useState } from 'react';
import Link from 'next/link';
import { arrivalSchema } from '@memoria/contracts';
import { contentRequest, ContentError } from '../lib/content-api.ts';
import { securityDestination } from '../lib/access-flow.ts';
export default function WorkspaceArrival({ workspaceId }: { workspaceId: string }) {
  const [arrival, setArrival] = useState<ReturnType<typeof arrivalSchema.parse>>(),
    [error, setError] = useState('');
  useEffect(() => {
    let active = true;
    void contentRequest(`/api/internal/workspaces/${workspaceId}/arrival`)
      .then((data) => {
        if (active) setArrival(arrivalSchema.parse(data));
      })
      .catch((e) => {
        if (e instanceof ContentError && e.code === 'STRONG_AUTH_REQUIRED')
          location.replace(securityDestination(`/workspaces/${workspaceId}/arrivee`));
        else if (active) setError('Reconnectez-vous pour vérifier votre accès à ce studio.');
      });
    return () => {
      active = false;
    };
  }, [workspaceId]);
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <Link className="quiet-link" href="/">
        Mes espaces
      </Link>
      <h1 className="text-3xl font-semibold">Bienvenue dans le studio</h1>
      {error && <p role="alert">{error}</p>}
      {!arrival && !error && <p>Vérification de votre accès…</p>}
      {arrival?.requiresStrongAuth ? (
        <>
          <p>
            Ce studio protège ses documents avec une seconde vérification. Ajoutez une clé d’accès
            ou utilisez une application d’authentification pour continuer.
          </p>
          <a
            className="primary inline-block"
            href={securityDestination(`/workspaces/${workspaceId}/arrivee`)}
          >
            Configurer ou vérifier mon identité
          </a>
        </>
      ) : (
        arrival?.contentAllowed && (
          <>
            <p>Votre accès au studio est prêt.</p>
            <Link className="primary inline-block" href={`/workspaces/${workspaceId}`}>
              Ouvrir le studio
            </Link>
          </>
        )
      )}
    </main>
  );
}
