'use client';
import Link from 'next/link';
import { useEffect, useState, useRef } from 'react';
import type { FormEvent } from 'react';
import {
  invitationCreateSchema,
  invitationListSchema,
  invitationSummarySchema,
  workspaceListSchema,
  workspaceMembersSchema,
  accessDraftSchema,
  pageTreeSchema,
} from '@memoria/contracts';
import type {
  InvitationSummary,
  PageSummary,
  InvitationRoot as Root,
  WorkspaceMember as Member,
  WorkspaceRole,
} from '@memoria/contracts';
import { authClient } from '../lib/auth-client.ts';
import { ContentError, contentRequest } from '../lib/content-api.ts';
import { accessDraft, securityDestination } from '../lib/access-flow.ts';
import { onLocalSignOut } from '../lib/local-sign-out.ts';
import { PageShares } from './page-shares.tsx';
const labels = {
  owner: 'Propriétaire',
  admin: 'Administrateur',
  member: 'Membre',
  guest: 'Invité',
};
function Roots({
  pages,
  value,
  onChange,
}: {
  pages: PageSummary[];
  value: Root[];
  onChange: (value: Root[]) => void;
}) {
  return (
    <fieldset className="space-y-2 rounded border p-3">
      <legend>Pages partagées et leurs sous-pages (20 maximum)</legend>
      <div className="max-h-64 overflow-y-auto">
        {pages.map((page) => {
          const root = value.find((r) => r.pageId === page.id);
          return (
            <div key={page.id} className="flex flex-wrap items-center gap-3 py-1">
              <label>
                <input
                  type="checkbox"
                  checked={!!root}
                  disabled={!root && value.length >= 20}
                  onChange={(e) =>
                    onChange(
                      e.target.checked
                        ? [...value, { pageId: page.id, level: 'read' }]
                        : value.filter((r) => r.pageId !== page.id),
                    )
                  }
                />{' '}
                {page.title || 'Sans titre'}
              </label>
              {root && (
                <select
                  aria-label={`Accès à ${page.title || 'Sans titre'}`}
                  value={root.level}
                  onChange={(e) =>
                    onChange(
                      value.map((r) =>
                        r.pageId === page.id ? { ...r, level: e.target.value as Root['level'] } : r,
                      ),
                    )
                  }
                >
                  <option value="read">Lecture</option>
                  <option value="edit">Édition</option>
                </select>
              )}
            </div>
          );
        })}
      </div>
      <p className="text-sm">
        Un accès en édition permet le contenu, le titre et la création de sous-pages. Il ne permet
        pas de déplacer ou de supprimer les pages.
      </p>
    </fieldset>
  );
}
export default function WorkspaceAccess({ workspaceId }: { workspaceId: string }) {
  const { data: session, isPending } = authClient.useSession();
  const retired = useRef(false);
  const [role, setRole] = useState(''),
    [pages, setPages] = useState<PageSummary[]>([]),
    [members, setMembers] = useState<Member[]>([]),
    [invitations, setInvitations] = useState<InvitationSummary[]>([]);
  const [email, setEmail] = useState(''),
    [inviteRole, setInviteRole] = useState<'admin' | 'member' | 'guest'>('member'),
    [roots, setRoots] = useState<Root[]>([]);
  const [editing, setEditing] = useState<Member | null>(null),
    [memberRole, setMemberRole] = useState<WorkspaceRole>('member'),
    [memberRoots, setMemberRoots] = useState<Root[]>([]);
  const [offset, setOffset] = useState(0),
    [revision, setRevision] = useState(0),
    [busy, setBusy] = useState(false),
    [loaded, setLoaded] = useState(false),
    [needsProof, setNeedsProof] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [sent, setSent] = useState<InvitationSummary>();
  const base = `/api/internal/workspaces/${workspaceId}`;
  useEffect(() => {
    if (!session) return;
    retired.current = false;
    const draft = accessDraftSchema.safeParse(accessDraft(session.user.id, workspaceId));
    if (draft.success) {
      setEmail(draft.data.email);
      setInviteRole(draft.data.role);
      setRoots(draft.data.roots);
      setEditing(draft.data.editing);
      setMemberRole(draft.data.memberRole);
      setMemberRoots(draft.data.memberRoots);
    }
    return onLocalSignOut(session.user.id, () => {
      retired.current = true;
      setMembers([]);
      setInvitations([]);
      setPages([]);
      setSent(undefined);
      setEmail('');
      setEditing(null);
      setLoaded(false);
    });
  }, [session?.user.id, workspaceId]);
  useEffect(() => {
    if (!session) return;
    let active = true;
    setLoaded(false);
    void (async () => {
      const workspaces = workspaceListSchema.parse(
        await contentRequest('/api/internal/workspaces'),
      );
      const current = workspaces.find((w) => w.id === workspaceId);
      if (!current || !['owner', 'admin'].includes(current.role))
        throw new Error('La gestion des accès est réservée aux administrateurs du studio.');
      const [people, pending, tree] = await Promise.all([
        contentRequest(`${base}/members?offset=${offset}`),
        contentRequest(`${base}/invitations?offset=${offset}`),
        contentRequest(`${base}/pages`),
      ]);
      if (active && !retired.current) {
        setRole(current.role);
        setMembers(workspaceMembersSchema.parse(people));
        setInvitations(invitationListSchema.parse(pending));
        setPages(pageTreeSchema.parse(tree).pages);
        setLoaded(true);
      }
    })().catch((e) => {
      if (active) {
        setError(e instanceof Error ? e.message : 'Impossible de charger les accès.');
        setNeedsProof(
          e instanceof ContentError &&
            ['STRONG_AUTH_REQUIRED', 'WORKSPACE_STRONG_AUTH_REQUIRED'].includes(e.code),
        );
      }
    });
    return () => {
      active = false;
    };
  }, [session?.user.id, session?.session.id, workspaceId, base, offset, revision]);
  async function run(action: () => Promise<void>) {
    if (busy) return;
    setBusy(true);
    setError('');
    setNotice('');
    setNeedsProof(false);
    try {
      await action();
      if (session) accessDraft(session.user.id, workspaceId, null);
      setRevision((n) => n + 1);
    } catch (e) {
      if (retired.current) return;
      if (
        e instanceof ContentError &&
        ['RECENT_STRONG_AUTH_REQUIRED', 'STRONG_AUTH_REQUIRED'].includes(e.code)
      ) {
        setNeedsProof(true);
        if (session)
          accessDraft(session.user.id, workspaceId, {
            email,
            role: inviteRole,
            roots,
            editing,
            memberRole,
            memberRoots,
          });
      } else setError(e instanceof Error ? e.message : 'La demande a échoué.');
    } finally {
      setBusy(false);
    }
  }
  async function invite(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const data = invitationCreateSchema.safeParse({
        email: email.trim(),
        role: inviteRole,
        roots: inviteRole === 'guest' ? roots : [],
      });
      if (!data.success)
        throw new Error('Vérifiez l’adresse et sélectionnez au moins une page pour un invité.');
      setSent(
        invitationSummarySchema.parse(
          await contentRequest(base + '/invitations', 'POST', data.data),
        ),
      );
      setEmail('');
      setRoots([]);
      setNotice('Invitation créée. Vous pouvez aussi copier son lien ci-dessous.');
    });
  }
  async function copy(item: InvitationSummary) {
    try {
      if (item.link) {
        await navigator.clipboard.writeText(item.link);
        setNotice('Lien copié. Seul le compte destinataire vérifié pourra accepter.');
      }
    } catch {
      setError('Copie indisponible. Sélectionnez le lien affiché pour le copier.');
    }
  }
  const delivery = (value: string) =>
    ({
      queued: 'Envoi en attente',
      sent: 'Email envoyé',
      retrying: 'Envoi à réessayer automatiquement',
      failed: 'Envoi échoué — copiez le lien',
      limited: 'Limite d’email atteinte — copiez le lien',
      expired: 'Envoi expiré — renvoyez l’invitation',
    })[value] ?? value;
  return (
    <main className="mx-auto max-w-4xl space-y-7 p-8">
      <nav className="flex gap-5">
        <Link className="quiet-link" href="/">
          Mes espaces
        </Link>
        <Link className="quiet-link" href={`/workspaces/${workspaceId}`}>
          Pages
        </Link>
        <Link className="quiet-link" href={`/workspaces/${workspaceId}/securite`}>
          Politique du studio
        </Link>
      </nav>
      <h1 className="text-3xl font-semibold">Membres et invitations</h1>
      {error && (
        <p className="notice error" role="alert">
          {error}
        </p>
      )}
      {notice && (
        <p className="notice" role="status">
          {notice}
        </p>
      )}
      {needsProof && (
        <section className="notice space-y-3" aria-label="Seconde vérification requise">
          <p>
            Pour gérer les accès au studio, ajoutez une seconde vérification à votre compte, puis
            vérifiez votre identité. Votre formulaire vous attendra ici.
          </p>
          <a
            className="primary inline-block"
            href={securityDestination(`/workspaces/${workspaceId}/acces`)}
          >
            Configurer ou vérifier mon identité
          </a>
          <p>Aucune invitation ne sera envoyée automatiquement à votre retour.</p>
        </section>
      )}
      {!session && !isPending && (
        <Link className="primary" href="/connexion">
          Se connecter
        </Link>
      )}
      {!loaded && !error && <p>Chargement des accès…</p>}
      {loaded && (
        <>
          {session && <PageShares workspace={workspaceId} user={session.user.id} pages={pages} />}
          <form onSubmit={invite} className="space-y-4 rounded border p-5">
            <h2 className="text-xl font-semibold">Inviter une personne</h2>
            <label className="block">
              Adresse email
              <input
                className="field mt-2"
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                required
                maxLength={254}
              />
            </label>
            <label className="block">
              Rôle de l’invitation
              <select
                className="field mt-2"
                value={inviteRole}
                onChange={(e) => setInviteRole(e.target.value as typeof inviteRole)}
              >
                <option value="member">Membre — tout le contenu</option>
                <option value="guest">Invité — pages choisies</option>
                {role === 'owner' && (
                  <option value="admin">Administrateur — gestion des accès</option>
                )}
              </select>
            </label>
            {inviteRole === 'guest' && <Roots pages={pages} value={roots} onChange={setRoots} />}
            <button className="primary" disabled={busy}>
              Envoyer l’invitation
            </button>
          </form>
          {sent && (
            <section className="notice space-y-2">
              <p>
                {sent.email} — {delivery(sent.deliveryStatus)}
              </p>
              {sent.link && (
                <>
                  <input
                    className="field"
                    aria-label="Lien de la nouvelle invitation"
                    readOnly
                    value={sent.link}
                  />
                  <button className="quiet-link" onClick={() => void copy(sent)}>
                    Copier le nouveau lien
                  </button>
                </>
              )}
            </section>
          )}
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Invitations</h2>
            {invitations.map((item) => (
              <article key={item.id} className="space-y-2 rounded border p-4">
                <p>
                  {item.email} — {labels[item.role]} —{' '}
                  {item.status === 'pending'
                    ? 'En attente'
                    : item.status === 'accepted'
                      ? 'Acceptée'
                      : item.status === 'expired'
                        ? 'Expirée'
                        : item.status === 'rejected'
                          ? 'Refusée'
                          : 'Annulée'}
                </p>
                <p>
                  {delivery(item.deliveryStatus)} ·{' '}
                  {new Date(item.expiresAt).toLocaleDateString('fr-FR')}
                </p>
                {item.link && (
                  <>
                    <input
                      className="field"
                      aria-label={`Lien pour ${item.email}`}
                      readOnly
                      value={item.link}
                    />
                    <button className="quiet-link mr-4" onClick={() => void copy(item)}>
                      Copier le lien
                    </button>
                  </>
                )}
                {['pending', 'expired'].includes(item.status) &&
                  (role === 'owner' || item.role !== 'admin') && (
                    <button
                      className="quiet-link mr-4"
                      disabled={busy}
                      onClick={() =>
                        void run(async () => {
                          setSent(
                            invitationSummarySchema.parse(
                              await contentRequest(
                                `${base}/invitations/${item.id}/resend`,
                                'POST',
                                {},
                              ),
                            ),
                          );
                          setNotice('Nouveau lien créé. L’ancien ne fonctionne plus.');
                        })
                      }
                    >
                      Renvoyer
                    </button>
                  )}
                {item.status === 'pending' && (role === 'owner' || item.role !== 'admin') && (
                  <button
                    className="quiet-link"
                    disabled={busy}
                    onClick={() =>
                      void run(async () => {
                        await contentRequest(`${base}/invitations/${item.id}/cancel`, 'POST', {});
                        setSent(undefined);
                        setNotice('Invitation annulée.');
                      })
                    }
                  >
                    Annuler
                  </button>
                )}
              </article>
            ))}
          </section>
          <section className="space-y-3">
            <h2 className="text-xl font-semibold">Membres du studio</h2>
            {members.map((person) => (
              <div
                className="flex items-center justify-between gap-4 rounded border p-4"
                key={person.id}
              >
                <span>
                  {person.name} — {labels[person.role]}
                </span>
                {(role === 'owner' || ['member', 'guest'].includes(person.role)) && (
                  <button
                    className="quiet-link"
                    onClick={() => {
                      setEditing(person);
                      setMemberRole(person.role);
                      setMemberRoots([]);
                    }}
                  >
                    Gérer {person.name}
                  </button>
                )}
              </div>
            ))}
          </section>
          {editing && (
            <section className="space-y-4 rounded border p-5" aria-label="Modifier un membre">
              <h2 className="text-xl">{editing.name}</h2>
              <label>
                Nouveau rôle
                <select
                  className="field mt-2"
                  value={memberRole}
                  onChange={(e) => setMemberRole(e.target.value as typeof memberRole)}
                >
                  {Object.entries(labels)
                    .filter(([key]) => role === 'owner' || ['member', 'guest'].includes(key))
                    .map(([key, label]) => (
                      <option key={key} value={key}>
                        {label}
                      </option>
                    ))}
                </select>
              </label>
              {memberRole === 'guest' && (
                <Roots pages={pages} value={memberRoots} onChange={setMemberRoots} />
              )}
              <p>
                Passer un invité en membre supprime ses anciens partages. Pour redevenir invité, il
                faudra choisir de nouveau ses pages.
              </p>
              <button
                className="primary mr-4"
                disabled={busy || memberRole === editing.role}
                onClick={() =>
                  void run(async () => {
                    await contentRequest(`${base}/members/${editing.id}/role`, 'PUT', {
                      expectedRole: editing.role,
                      role: memberRole,
                      roots: memberRole === 'guest' ? memberRoots : [],
                    });
                    setEditing(null);
                    setNotice('Rôle enregistré.');
                  })
                }
              >
                Enregistrer le rôle
              </button>
              <button
                className="quiet-link mr-4"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    if (!confirm(`Retirer ${editing.name} de ce studio ?`)) return;
                    await contentRequest(`${base}/members/${editing.id}`, 'DELETE', {
                      expectedRole: editing.role,
                    });
                    setEditing(null);
                    setNotice('Accès au studio retiré.');
                  })
                }
              >
                Retirer du studio
              </button>
              <button className="quiet-link" onClick={() => setEditing(null)}>
                Fermer
              </button>
            </section>
          )}
          <nav className="flex gap-6" aria-label="Pagination des accès">
            <button
              disabled={!offset || busy}
              onClick={() => setOffset((n) => Math.max(0, n - 50))}
            >
              Précédent
            </button>
            <span>À partir de {offset + 1}</span>
            <button
              disabled={busy || (members.length < 50 && invitations.length < 50)}
              onClick={() => setOffset((n) => n + 50)}
            >
              Suivant
            </button>
          </nav>
        </>
      )}
    </main>
  );
}
