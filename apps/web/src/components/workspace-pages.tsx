'use client';
import dynamic from 'next/dynamic';
import { useCallback, useEffect, useRef, useState } from 'react';
import { useRouter } from 'next/navigation';
import {
  pageDocumentSchema,
  pageSchema,
  pageTreeSchema,
  searchResultsSchema,
  workspaceListSchema,
} from '@memoria/contracts';
import type { PageDocument, PageSummary } from '@memoria/contracts';
import { authClient } from '../lib/auth-client.ts';
import { contentRequest } from '../lib/content-api.ts';
import { onLocalSignOut } from '../lib/local-sign-out.ts';
import type { EditorActions } from './page-editor.tsx';
const PageEditor = dynamic(() => import('./page-editor.tsx'), {
  ssr: false,
  loading: () => (
    <p className="p-6" role="status">
      Chargement de l’éditeur…
    </p>
  ),
});
export default function WorkspacePages({ workspaceId }: { workspaceId: string }) {
  const router = useRouter();
  const { data: session, isPending } = authClient.useSession();
  const base = `/api/internal/workspaces/${encodeURIComponent(workspaceId)}`;
  const [name, setName] = useState('Espace de travail');
  const [tree, setTree] = useState<{ pages: PageSummary[]; trash: PageSummary[] }>({
    pages: [],
    trash: [],
  });
  const [document, setDocument] = useState<PageDocument>();
  const [generation, setGeneration] = useState(0);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [dirty, setDirty] = useState(false);
  const [pendingPage, setPendingPage] = useState<string>();
  const [query, setQuery] = useState('');
  const [searchRevision, setSearchRevision] = useState(0);
  const [results, setResults] = useState<{ id: string; title: string; excerpt: string }[]>([]);
  const [parent, setParent] = useState('');
  const [after, setAfter] = useState('');
  const [showMove, setShowMove] = useState(false);
  const editorActions = useRef<EditorActions | null>(null);
  const locallyClosed = useRef(false);
  const [signedOut, setSignedOut] = useState('');
  const closeLocalSession = useCallback((message = 'Session fermée sur ce poste.') => {
    locallyClosed.current = true;
    setSignedOut(message);
    setDocument(undefined);
    setDirty(false);
    setTree({ pages: [], trash: [] });
    setResults([]);
  }, []);
  useEffect(() => {
    if (!session) return;
    return onLocalSignOut(session.user.id, closeLocalSession);
  }, [session?.user.id, closeLocalSession]);
  useEffect(() => {
    setDocument(undefined);
    setDirty(false);
  }, [session?.user.id, session?.session.id]);
  useEffect(() => {
    if (!isPending && !session && !signedOut) router.replace('/connexion');
  }, [isPending, session, signedOut, router]);
  async function refresh() {
    if (locallyClosed.current) return;
    const data = pageTreeSchema.parse(await contentRequest(`${base}/pages`));
    if (locallyClosed.current) return;
    setTree(data);
    setSearchRevision((n) => n + 1);
  }
  useEffect(() => {
    if (!session) return;
    let cancelled = false;
    Promise.all([contentRequest(`${base}/pages`), contentRequest('/api/internal/workspaces')])
      .then(([pages, workspaces]) => {
        if (cancelled || locallyClosed.current) return;
        setTree(pageTreeSchema.parse(pages));
        setName(
          workspaceListSchema.parse(workspaces).find((w) => w.id === workspaceId)?.name ??
            'Espace de travail',
        );
      })
      .catch((e: unknown) => {
        if (!cancelled) setError(e instanceof Error ? e.message : 'Chargement impossible.');
      });
    return () => {
      cancelled = true;
    };
  }, [base, workspaceId, session?.user.id]);
  async function open(id: string, discard = false) {
    if (locallyClosed.current) return;
    if (dirty && !discard) {
      setPendingPage(id);
      return;
    }
    setBusy(true);
    setError('');
    try {
      const next = pageDocumentSchema.parse(await contentRequest(`${base}/pages/${id}`));
      // A conflict reload must also refresh tree titles, parents and mutation versions.
      await refresh();
      if (discard) await editorActions.current?.discard();
      if (locallyClosed.current) return;
      setDocument(next);
      setDirty(false);
      setGeneration((n) => n + 1);
      setPendingPage(undefined);
      setShowMove(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Chargement impossible.');
    } finally {
      setBusy(false);
    }
  }
  async function create(parentId: string | null) {
    if (locallyClosed.current) return;
    setBusy(true);
    setError('');
    try {
      const page = pageSchema.parse(
        await contentRequest(`${base}/pages`, 'POST', { title: 'Sans titre', parentId }),
      );
      await refresh();
      await open(page.id);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Création impossible.');
    } finally {
      setBusy(false);
    }
  }
  async function mutate(page: PageSummary, action: 'move' | 'archive' | 'restore') {
    if (locallyClosed.current) return;
    setBusy(true);
    setError('');
    try {
      // Read the latest listed version for own saves. Server CAS still arbitrates concurrent changes.
      await contentRequest(`${base}/pages/${page.id}/${action}`, 'POST', {
        expectedVersion: page.version,
        ...(action === 'move' ? { parentId: parent || null, afterId: after || null } : {}),
      });
      await refresh();
      if (action === 'archive') {
        setDocument(undefined);
        setDirty(false);
      } else await open(page.id, true);
    } catch (e) {
      setError(e instanceof Error ? e.message : 'Modification impossible.');
      await refresh().catch(() => {});
    } finally {
      setBusy(false);
    }
  }
  useEffect(() => {
    if (!session || !query.trim()) {
      setResults([]);
      return;
    }
    let cancelled = false;
    const timer = globalThis.setTimeout(() => {
      contentRequest(`${base}/search?q=${encodeURIComponent(query.trim())}`)
        .then((data) => {
          if (!cancelled && !locallyClosed.current) setResults(searchResultsSchema.parse(data));
        })
        .catch((e: unknown) => {
          if (!cancelled) setError(e instanceof Error ? e.message : 'Recherche impossible.');
        });
    }, 250);
    return () => {
      cancelled = true;
      globalThis.clearTimeout(timer);
    };
  }, [query, base, searchRevision, session?.user.id]);
  function branches(parentId: string | null): React.ReactNode {
    return (
      <ul className={parentId ? 'ml-4 border-l border-[#d7ded3] pl-2' : ''}>
        {tree.pages
          .filter((p) => p.parentId === parentId)
          .map((page) => (
            <li key={page.id}>
              <button
                disabled={busy}
                className={`page-tree-item ${document?.page.id === page.id ? 'selected' : ''}`}
                onClick={() => void open(page.id)}
              >
                <span aria-hidden="true">▤</span> {page.title || 'Sans titre'}
              </button>
              {branches(page.id)}
            </li>
          ))}
      </ul>
    );
  }
  const selected = tree.pages.find((p) => p.id === document?.page.id);
  if (signedOut)
    return (
      <main className="p-8">
        <p role="status">{signedOut}</p>
        <p className="my-4">Reconnectez-vous pour accéder à votre espace.</p>
        <a className="primary" href="/connexion">
          Se reconnecter
        </a>
      </main>
    );
  if (isPending || !session)
    return (
      <p role="status" className="p-8">
        Chargement de votre espace…
      </p>
    );
  return (
    <main className="workspace-layout">
      <aside className="workspace-sidebar">
        <a href="/" className="mb-8 block text-2xl font-semibold tracking-tight">
          m<span className="text-[#b58641]">.</span> memoria
        </a>
        <h1 className="mb-5 text-lg font-semibold">{name}</h1>
        <a className="quiet-link mb-5 block text-sm" href={`/workspaces/${workspaceId}/securite`}>
          Sécurité de l’espace
        </a>
        <label className="block text-xs font-medium uppercase tracking-wider">
          Recherche
          <input
            aria-label="Rechercher dans l’espace"
            className="field my-2 text-sm normal-case tracking-normal"
            placeholder="Un mot, une idée…"
            value={query}
            maxLength={200}
            onChange={(e) => setQuery(e.target.value)}
          />
        </label>
        {query.trim() && (
          <section aria-label="Résultats de recherche" className="mb-5">
            {results.length === 0 ? (
              <p className="text-sm text-[#687566]">Aucun résultat.</p>
            ) : (
              results.map((item) => (
                <button
                  disabled={busy}
                  className="search-result"
                  key={item.id}
                  onClick={() => void open(item.id)}
                >
                  <strong>{item.title || 'Sans titre'}</strong>
                  <span>{item.excerpt}</span>
                </button>
              ))
            )}
          </section>
        )}
        <div className="mb-3 mt-6 flex items-center justify-between">
          <h2 className="text-xs font-semibold uppercase tracking-widest text-[#6a7868]">Pages</h2>
          <button
            className="quiet-link text-sm"
            disabled={busy || dirty}
            onClick={() => void create(null)}
          >
            + Nouvelle page
          </button>
        </div>
        <nav aria-label="Arbre des pages">{branches(null)}</nav>
        {tree.pages.length === 0 && (
          <p className="mt-5 text-sm leading-relaxed text-[#73806f]">
            Créez une page pour rassembler les idées de votre studio.
          </p>
        )}
        <details className="mt-10 text-sm">
          <summary className="cursor-pointer text-[#687566]">
            Corbeille ({tree.trash.length})
          </summary>
          {tree.trash.map((page) => (
            <div key={page.id} className="my-3 flex items-center justify-between gap-2">
              <span>{page.title || 'Sans titre'}</span>
              <button
                className="quiet-link"
                disabled={busy || dirty}
                onClick={() => void mutate(page, 'restore')}
              >
                Restaurer
              </button>
            </div>
          ))}
        </details>
        <p className="mt-auto pt-10 text-xs text-[#7b8776]">
          {session.user.name} · atelier partagé
        </p>
      </aside>
      <section className="min-w-0 flex-1">
        <header className="workspace-topbar">
          <span className="text-sm text-[#687566]">
            {name} / {selected?.title || 'Pages'}
          </span>
          <div className="flex gap-4 text-sm">
            {selected && (
              <>
                <button
                  className="quiet-link"
                  disabled={busy || dirty}
                  onClick={() => void create(selected.id)}
                >
                  + Sous-page
                </button>
                <button
                  className="quiet-link"
                  disabled={busy || dirty}
                  onClick={() => {
                    setParent(selected.parentId ?? '');
                    setAfter('');
                    setShowMove(!showMove);
                  }}
                >
                  Déplacer
                </button>
                <button
                  className="quiet-link"
                  disabled={busy || dirty}
                  onClick={() => void mutate(selected, 'archive')}
                >
                  Mettre à la corbeille
                </button>
              </>
            )}
          </div>
        </header>
        {error && (
          <p role="alert" className="notice error m-6">
            {error}
          </p>
        )}
        {pendingPage && (
          <div role="dialog" aria-label="Modifications non enregistrées" className="notice m-6">
            <p>
              Cette page contient des modifications non enregistrées. Restez sur la page jusqu’à
              confirmation, ou exportez le contenu affiché avant de l’abandonner.
            </p>
            <button className="quiet-link mr-5" onClick={() => setPendingPage(undefined)}>
              Rester sur la page
            </button>
            <button className="primary" onClick={() => void open(pendingPage, true)}>
              Abandonner et ouvrir
            </button>
          </div>
        )}
        {showMove && selected && (
          <form
            className="notice m-6 flex flex-wrap items-end gap-4"
            onSubmit={(e) => {
              e.preventDefault();
              void mutate(selected, 'move');
            }}
          >
            <label>
              Page parente
              <select
                className="field"
                value={parent}
                onChange={(e) => {
                  setParent(e.target.value);
                  setAfter('');
                }}
              >
                <option value="">Racine</option>
                {tree.pages
                  .filter((p) => p.id !== selected.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || 'Sans titre'}
                    </option>
                  ))}
              </select>
            </label>
            <label>
              Placer après
              <select className="field" value={after} onChange={(e) => setAfter(e.target.value)}>
                <option value="">En premier</option>
                {tree.pages
                  .filter((p) => p.parentId === (parent || null) && p.id !== selected.id)
                  .map((p) => (
                    <option key={p.id} value={p.id}>
                      {p.title || 'Sans titre'}
                    </option>
                  ))}
              </select>
            </label>
            <button className="primary" disabled={busy || dirty}>
              Déplacer la page
            </button>
          </form>
        )}
        {document ? (
          <PageEditor
            userId={session.user.id}
            userName={session.user.name}
            sessionId={session.session.id}
            key={`${session.user.id}-${document.page.id}-${generation}`}
            actions={editorActions}
            document={document}
            endpoint={`${base}/pages/${document.page.id}`}
            onDirty={setDirty}
            onLocalRevoked={closeLocalSession}
            onSaved={() => {
              void refresh().catch(() => {});
            }}
            reload={() => {
              void open(document.page.id, true);
            }}
          />
        ) : (
          <div className="workspace-empty">
            <span className="text-5xl text-[#b4bfae]" aria-hidden="true">
              ✦
            </span>
            <h2 className="mt-6 text-3xl font-semibold">Les idées prennent place ici.</h2>
            <p className="mt-4 text-[#73806f]">
              Ouvrez une page ou créez la première note de votre atelier.
            </p>
            <button className="primary mt-8" disabled={busy} onClick={() => void create(null)}>
              Créer une page
            </button>
          </div>
        )}
      </section>
    </main>
  );
}
