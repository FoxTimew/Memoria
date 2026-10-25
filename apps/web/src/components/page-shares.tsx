'use client';
import { useEffect, useRef, useState } from 'react';
import { pageSharesSchema, shareDraftSchema } from '@memoria/contracts';
import type { PageSummary, ShareDraft } from '@memoria/contracts';
import { contentRequest, ContentError } from '../lib/content-api.ts';
import { accessDraft, securityDestination } from '../lib/access-flow.ts';
import { onLocalSignOut } from '../lib/local-sign-out.ts';
const label = { read: 'Lecture', edit: 'Édition', none: 'Aucun partage direct' };
export function PageShares({
  workspace,
  user,
  pages,
}: {
  workspace: string;
  user: string;
  pages: PageSummary[];
}) {
  const [page, setPage] = useState(''),
    [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0);
  const [data, setData] = useState<ReturnType<typeof pageSharesSchema.parse>>();
  const [draft, setDraft] = useState<ShareDraft>();
  const [error, setError] = useState(''),
    [proof, setProof] = useState(false),
    [busy, setBusy] = useState(false),
    [notice, setNotice] = useState('');
  const retired = useRef(false);
  useEffect(() => {
    const saved = shareDraftSchema.safeParse(accessDraft(user, `${workspace}:share`));
    if (saved.success) {
      setPage(saved.data.page);
      setDraft(saved.data);
    }
    return onLocalSignOut(user, () => {
      retired.current = true;
      setData(undefined);
      setDraft(undefined);
      setPage('');
    });
  }, [user, workspace]);
  useEffect(() => {
    let active = true;
    setData(undefined);
    if (page)
      void contentRequest(
        `/api/internal/workspaces/${workspace}/pages/${page}/shares?limit=50&offset=${offset}`,
      )
        .then((value) => {
          if (active && !retired.current) setData(pageSharesSchema.parse(value));
        })
        .catch((e) => {
          if (active) setError(e instanceof Error ? e.message : 'Lecture impossible.');
        });
    return () => {
      active = false;
    };
  }, [workspace, page, offset, revision]);
  async function save() {
    if (!data || !draft || draft.page !== page || retired.current) return;
    setBusy(true);
    setError('');
    setNotice('');
    setProof(false);
    try {
      await contentRequest(
        `/api/internal/workspaces/${workspace}/pages/${page}/shares/${draft.member}`,
        'PUT',
        {
          expectedAccessVersion: data.accessVersion,
          level: draft.level === 'none' ? null : draft.level,
        },
      );
      if (retired.current) return;
      accessDraft(user, `${workspace}:share`, null);
      setDraft(undefined);
      setNotice('Partage enregistré. Les accès s’appliquent aussi aux sous-pages.');
      setRevision((n) => n + 1);
    } catch (e) {
      if (
        e instanceof ContentError &&
        ['RECENT_STRONG_AUTH_REQUIRED', 'STRONG_AUTH_REQUIRED'].includes(e.code)
      ) {
        accessDraft(user, `${workspace}:share`, draft);
        setProof(true);
      } else {
        setError(e instanceof Error ? e.message : 'Modification impossible.');
        setRevision((n) => n + 1);
      }
    } finally {
      setBusy(false);
    }
  }
  return (
    <section className="space-y-4 rounded border p-5" aria-label="Partages de pages">
      <h2 className="text-xl font-semibold">Partages de pages</h2>
      <p>
        Les membres voient tout le studio. Choisissez les pages accessibles à chaque invité. Le
        droit le plus élevé s’applique lorsqu’il existe plusieurs partages.
      </p>
      <label className="block">
        Page à partager
        <select
          className="field"
          value={page}
          onChange={(e) => {
            setPage(e.target.value);
            setOffset(0);
            setDraft(undefined);
            setProof(false);
            setNotice('');
          }}
        >
          <option value="">Choisir une page</option>
          {pages.map((p) => (
            <option key={p.id} value={p.id}>
              {p.title || 'Sans titre'}
            </option>
          ))}
        </select>
      </label>
      {error && (
        <p role="alert" className="notice error">
          {error}
        </p>
      )}
      {notice && (
        <p role="status" className="notice">
          {notice}
        </p>
      )}
      {proof && (
        <div className="notice space-y-3">
          <p>
            Pour partager cette page, ajoutez une seconde vérification à votre compte, puis vérifiez
            votre identité. Votre choix vous attendra ici ; vous pourrez ensuite confirmer le
            partage.
          </p>
          <a
            className="primary inline-block"
            href={securityDestination(`/workspaces/${workspace}/acces`)}
          >
            Configurer ou vérifier mon identité
          </a>
        </div>
      )}
      {data?.guests.map((guest) => (
        <div key={guest.memberId} className="space-y-2 rounded border p-3">
          <strong>{guest.name}</strong>
          <p>Accès effectif : {guest.level ? label[guest.level] : 'Aucun accès'}</p>
          {guest.sources.length > 0 && (
            <ul>
              {guest.sources.map((source) => (
                <li key={source.pageId}>
                  {source.pageId === page ? 'Partage direct' : 'Hérité de « ' + source.title + ' »'}{' '}
                  : {label[source.level]}
                </li>
              ))}
            </ul>
          )}
          <label>
            Partage direct pour {guest.name}
            <select
              className="field"
              value={
                draft?.member === guest.memberId && draft.page === page
                  ? draft.level
                  : (guest.direct ?? 'none')
              }
              onChange={(e) =>
                setDraft({
                  page,
                  member: guest.memberId,
                  level: e.target.value as 'none' | 'read' | 'edit',
                })
              }
            >
              <option value="none">Aucun partage direct</option>
              <option value="read">Lecture</option>
              <option value="edit">Édition</option>
            </select>
          </label>
          <button
            className="primary"
            disabled={busy || draft?.member !== guest.memberId || draft?.page !== page}
            onClick={() => void save()}
          >
            Enregistrer le partage pour {guest.name}
          </button>
          {guest.sources.some((s) => s.pageId !== page) && (
            <p className="text-sm">
              Retirer ce partage direct ne retire pas un accès hérité. Modifiez le partage de la
              page parente indiquée ci-dessus pour le réduire.
            </p>
          )}
        </div>
      ))}
      {data?.guests.length === 0 && (
        <p>
          Aucun invité sur cette page de résultats. Invitez une personne avec le rôle Invité pour
          lui partager des pages.
        </p>
      )}
      {data && (
        <div className="flex gap-4">
          <button
            className="quiet-link"
            disabled={offset === 0}
            onClick={() => setOffset((n) => Math.max(0, n - 50))}
          >
            Invités précédents
          </button>
          <button
            className="quiet-link"
            disabled={data.guests.length < 50}
            onClick={() => setOffset((n) => n + 50)}
          >
            Invités suivants
          </button>
        </div>
      )}
    </section>
  );
}
