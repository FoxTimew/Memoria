'use client';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import { invitationSummarySchema, invitationListSchema, arrivalSchema } from '@memoria/contracts';
import type { InvitationSummary } from '@memoria/contracts';
import { authClient } from '../lib/auth-client.ts';
import { ContentError, contentRequest } from '../lib/content-api.ts';
import { pendingInvitation, securityDestination } from '../lib/access-flow.ts';
import { onLocalSignOut } from '../lib/local-sign-out.ts';
export default function InvitationScreen() {
  const { data: session, isPending } = authClient.useSession();
  const retired = useRef(false);
  const [id, setId] = useState<string | null>(null),
    [ready, setReady] = useState(false),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [needsProof, setNeedsProof] = useState(false);
  const [selected, setSelected] = useState<InvitationSummary>(),
    [list, setList] = useState<InvitationSummary[]>([]),
    [offset, setOffset] = useState(0);
  useEffect(() => {
    const incoming = new URLSearchParams(location.hash.slice(1)).get('id');
    if (incoming) pendingInvitation(incoming);
    history.replaceState(null, '', '/invitation');
    setId(pendingInvitation());
    setReady(true);
  }, []);
  useEffect(() => {
    if (!session) return;
    retired.current = false;
    return onLocalSignOut(session.user.id, () => {
      retired.current = true;
      setSelected(undefined);
      setList([]);
      setId(null);
    });
  }, [session?.user.id]);
  useEffect(() => {
    if (!ready || !session) return;
    let active = true;
    setError('');
    setSelected(undefined);
    setList([]);
    setNeedsProof(false);
    const request = id
      ? contentRequest('/api/internal/invitations/resolve', 'POST', { id })
      : contentRequest(`/api/internal/invitations?offset=${offset}`);
    void request
      .then((data) => {
        if (active && !retired.current) {
          if (id) setSelected(invitationSummarySchema.parse(data));
          else setList(invitationListSchema.parse(data));
        }
      })
      .catch((e) => {
        if (active) {
          setNeedsProof(e instanceof ContentError && e.code === 'STRONG_AUTH_REQUIRED');
          setError(
            'Cette invitation ne peut pas être ouverte avec ce compte, ou elle a expiré. Vérifiez le compte destinataire et rouvrez le lien reçu.',
          );
        }
      });
    return () => {
      active = false;
    };
  }, [ready, session?.user.id, session?.session.id, id, offset]);
  async function respond(accept: boolean) {
    if (!selected || busy) return;
    setBusy(true);
    setError('');
    try {
      const result = await contentRequest(
        `/api/internal/invitations/${accept ? 'accept' : 'reject'}`,
        'POST',
        { id: selected.id },
      );
      pendingInvitation(null);
      if (accept) {
        const next = arrivalSchema.parse(result);
        location.replace(`/workspaces/${next.workspaceId}/arrivee`);
      } else {
        setSelected(undefined);
        setId(null);
        setError('Invitation refusée.');
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Impossible de répondre.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-2xl space-y-6 p-8">
      <Link className="quiet-link" href="/">
        Mes espaces
      </Link>
      <h1 className="text-3xl font-semibold">Rejoindre un studio</h1>
      {isPending || !ready ? (
        <p>Chargement…</p>
      ) : !session ? (
        <>
          <p>
            Connectez-vous avec l’adresse qui a reçu l’invitation. Si vous n’avez pas de compte,
            créez-en un et vérifiez votre adresse email.
          </p>
          <Link className="primary mr-4" href="/connexion">
            Se connecter
          </Link>
          <Link className="quiet-link" href="/inscription">
            Créer un compte
          </Link>
        </>
      ) : (
        <>
          {error && (
            <section className="notice space-y-3">
              <p role="alert">{error}</p>
              <Link className="quiet-link" href="/securite">
                Changer de compte
              </Link>
              <p className="text-sm">
                Déconnectez-vous sur cet écran, puis rouvrez le lien reçu avec le compte
                destinataire.
              </p>
            </section>
          )}
          {needsProof && (
            <a className="primary inline-block" href={securityDestination('/invitation')}>
              Vérifier mon identité
            </a>
          )}
          {selected ? (
            <section className="space-y-4 rounded border p-5">
              <h2 className="text-xl">{selected.workspaceName}</h2>
              <p>
                Vous êtes invité comme{' '}
                {selected.role === 'guest'
                  ? 'invité'
                  : selected.role === 'admin'
                    ? 'administrateur'
                    : 'membre'}
                . Valable jusqu’au {new Date(selected.expiresAt).toLocaleDateString('fr-FR')}.
              </p>
              <button className="primary mr-4" disabled={busy} onClick={() => void respond(true)}>
                Accepter l’invitation
              </button>
              <button className="quiet-link" disabled={busy} onClick={() => void respond(false)}>
                Refuser
              </button>
            </section>
          ) : (
            !id &&
            !needsProof && (
              <>
                <ul className="space-y-3">
                  {list.map((item) => (
                    <li key={item.id}>
                      <button
                        className="quiet-link"
                        onClick={() => {
                          pendingInvitation(item.id);
                          setId(item.id);
                        }}
                      >
                        {item.workspaceName} — ouvrir l’invitation
                      </button>
                    </li>
                  ))}
                </ul>
                {!list.length && <p>Aucune invitation en attente.</p>}
                <button disabled={!offset} onClick={() => setOffset((n) => Math.max(0, n - 50))}>
                  Précédent
                </button>
                <button
                  className="ml-5"
                  disabled={list.length < 50}
                  onClick={() => setOffset((n) => n + 50)}
                >
                  Suivant
                </button>
              </>
            )
          )}
          {id && (
            <button
              className="quiet-link"
              onClick={() => {
                pendingInvitation(null);
                setId(null);
              }}
            >
              Voir mes autres invitations
            </button>
          )}
        </>
      )}
    </main>
  );
}
