'use client';

import { useRouter } from 'next/navigation';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { workspaceListSchema, workspaceSummarySchema } from '@memoria/contracts';
import type { WorkspaceSummary } from '@memoria/contracts';
import { authClient } from '../lib/auth-client.ts';

export default function Home() {
  const router = useRouter();
  const { data: session, isPending, error: sessionError } = authClient.useSession();
  const [workspaces, setWorkspaces] = useState<WorkspaceSummary[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [reload, setReload] = useState(0);

  useEffect(() => {
    if (!isPending && !session && !sessionError) router.replace('/connexion');
  }, [isPending, session, sessionError, router]);

  useEffect(() => {
    if (!session) return;
    const controller = new AbortController();
    setLoading(true);
    setError('');
    globalThis
      .fetch('/api/internal/workspaces', { credentials: 'include', signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error('Workspaces unavailable');
        const data: unknown = await response.json();
        setWorkspaces(workspaceListSchema.parse(data));
      })
      .catch(() => {
        if (!controller.signal.aborted) setError('Impossible de charger vos espaces. Réessayez.');
      })
      .finally(() => {
        if (!controller.signal.aborted) setLoading(false);
      });
    return () => controller.abort();
  }, [session?.user.id, reload]);

  async function create(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const formElement = event.currentTarget;
    const form = new FormData(formElement);
    setBusy(true);
    setError('');
    setNotice('');
    try {
      const response = await globalThis.fetch('/api/internal/workspaces', {
        method: 'POST',
        credentials: 'include',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          name: String(form.get('name')).trim(),
          slug: String(form.get('slug')).trim(),
        }),
      });
      if (response.status === 409) {
        setError('Cet identifiant est déjà utilisé. Choisissez-en un autre.');
        return;
      }
      if (!response.ok) throw new Error('Workspace creation failed');
      const data: unknown = await response.json();
      const workspace = workspaceSummarySchema.parse(data);
      setWorkspaces((current) => [...current, workspace]);
      setNotice(`L’espace « ${workspace.name} » est prêt.`);
      formElement.reset();
    } catch {
      setError('La création n’a pas abouti. Réessayez.');
    } finally {
      setBusy(false);
    }
  }

  async function signOut() {
    setBusy(true);
    setError('');
    try {
      const result = await authClient.signOut();
      if (result.error) throw new Error('Sign out failed');
      router.replace('/connexion');
    } catch {
      setError('La déconnexion a échoué. Réessayez.');
    } finally {
      setBusy(false);
    }
  }

  if (sessionError)
    return (
      <main className="mx-auto max-w-md p-8">
        <p role="alert" className="notice error">
          La connexion au service a échoué.
        </p>
        <button className="primary mt-4" onClick={() => globalThis.location.reload()}>
          Réessayer
        </button>
      </main>
    );
  if (isPending || !session)
    return (
      <p role="status" className="p-8">
        Chargement de votre espace…
      </p>
    );

  return (
    <main className="min-h-screen">
      <header className="flex flex-wrap items-center justify-between gap-4 border-b border-[#d9ded5] bg-white px-6 py-5 lg:px-12">
        <span className="text-2xl font-semibold tracking-tight">
          m<span className="text-[#b58641]">.</span> memoria
        </span>
        <div className="flex items-center gap-5 text-sm">
          <span>{session.user.name}</span>
          <button className="quiet-link" disabled={busy} onClick={signOut}>
            Se déconnecter
          </button>
        </div>
      </header>
      <div className="mx-auto max-w-6xl px-6 py-12 lg:py-20">
        <p className="mb-3 text-xs font-semibold uppercase tracking-[.2em] text-[#7b877c]">
          Votre atelier
        </p>
        <h1 className="text-4xl font-semibold tracking-tight">Vos espaces de travail</h1>
        <p className="mt-4 max-w-lg leading-relaxed text-[#657267]">
          Un espace pour chaque studio, chaque équipe ou chaque nouvelle aventure.
        </p>
        <div className="mt-12 grid items-start gap-10 lg:grid-cols-[1.4fr_1fr]">
          <section aria-label="Mes espaces" className="space-y-4">
            {loading ? (
              <p role="status">Chargement des espaces…</p>
            ) : workspaces.length === 0 ? (
              <div className="rounded-2xl border border-dashed border-[#bac7b9] px-8 py-14 text-center">
                <div className="mb-4 text-4xl text-[#9ead9c]" aria-hidden="true">
                  ✦
                </div>
                <h2 className="text-xl font-medium">Tout commence par un espace.</h2>
                <p className="mt-3 text-sm leading-relaxed text-[#657267]">
                  Créez votre premier espace de travail
                  <br />
                  pour rassembler les idées de votre studio.
                </p>
              </div>
            ) : (
              workspaces.map((workspace) => (
                <article
                  key={workspace.id}
                  className="flex items-center gap-5 rounded-xl border border-[#d8ded4] bg-white p-6"
                >
                  <div
                    aria-hidden="true"
                    className="flex h-12 w-12 shrink-0 items-center justify-center rounded-xl bg-[#eaf0e5] text-xl font-medium"
                  >
                    {workspace.name.slice(0, 1).toUpperCase()}
                  </div>
                  <div className="min-w-0">
                    <h2 className="truncate text-lg font-semibold">{workspace.name}</h2>
                    <p className="mt-1 text-sm text-[#657267]">
                      {workspace.slug} · {workspace.role === 'owner' ? 'Propriétaire' : 'Membre'}
                    </p>
                  </div>
                </article>
              ))
            )}
            {notice && (
              <p role="status" className="notice">
                {notice}
              </p>
            )}
            {error && (
              <div role="alert" className="notice error">
                {error}
                <button onClick={() => setReload((value) => value + 1)} className="quiet-link ml-3">
                  Actualiser la liste
                </button>
              </div>
            )}
          </section>
          <section className="rounded-2xl border border-[#d8ded4] bg-white p-7 shadow-sm">
            <h2 className="mb-2 text-xl font-semibold">Créer un espace</h2>
            <p className="mb-6 text-sm leading-relaxed text-[#657267]">
              Donnez-lui un nom. Vous en serez le propriétaire.
            </p>
            <form className="space-y-5" onSubmit={create}>
              <label className="block text-sm font-medium">
                Nom de l’espace
                <input
                  className="field mt-2"
                  name="name"
                  placeholder="Studio Lanterne"
                  maxLength={100}
                  required
                />
              </label>
              <label className="block text-sm font-medium">
                Identifiant
                <input
                  className="field mt-2"
                  name="slug"
                  placeholder="studio-lanterne"
                  pattern="[a-z0-9]+(-[a-z0-9]+)*"
                  minLength={3}
                  maxLength={63}
                  required
                />
                <span className="mt-2 block text-xs font-normal text-[#657267]">
                  Lettres minuscules, chiffres et tirets. Il doit être unique.
                </span>
              </label>
              <button type="submit" className="primary w-full" disabled={busy}>
                {' '}
                {busy ? 'Un instant…' : 'Créer mon espace'}
              </button>
            </form>
          </section>
        </div>
      </div>
    </main>
  );
}
