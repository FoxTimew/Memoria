'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import { workspaceSecuritySchema, workspaceMembersSchema } from '@memoria/contracts';
import type { WorkspaceSecurity } from '@memoria/contracts';
import { contentRequest } from '../lib/content-api.ts';
export default function WorkspaceSecurityPage({ workspaceId }: { workspaceId: string }) {
  const base = `/api/internal/workspaces/${encodeURIComponent(workspaceId)}`;
  const [policy, setPolicy] = useState<WorkspaceSecurity>();
  const [members, setMembers] = useState<ReturnType<typeof workspaceMembersSchema.parse>>([]);
  const [required, setRequired] = useState(false),
    [days, setDays] = useState(7),
    [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  async function load() {
    const data = workspaceSecuritySchema.parse(await contentRequest(base + '/security'));
    setPolicy(data);
    setRequired(data.requireStrongAuth);
    setDays(data.graceDays);
    setMembers(
      data.role === 'owner' && data.contentAllowed
        ? workspaceMembersSchema.parse(await contentRequest(base + '/members'))
        : [],
    );
  }
  useEffect(() => {
    void load().catch((e) => setError(e instanceof Error ? e.message : 'Chargement impossible.'));
  }, [base]);
  async function run(work: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await work();
      await load();
    } catch (e) {
      setError(e instanceof Error ? e.message : 'La demande a échoué.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-3xl space-y-6 px-6 py-10">
      <h1 className="text-3xl font-semibold">Sécurité de l’espace</h1>
      <nav className="flex flex-wrap gap-6">
        <Link className="quiet-link" href={`/workspaces/${workspaceId}`}>
          Retour aux pages
        </Link>
        <Link className="quiet-link" href="/securite">
          Sécurité du compte
        </Link>
        <Link className="quiet-link" href="/">
          Mes espaces
        </Link>
      </nav>
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
      <button className="quiet-link" disabled={busy} onClick={() => void run(load)}>
        Actualiser
      </button>
      {policy && (
        <>
          <p className="notice">
            {policy.requireStrongAuth
              ? 'La connexion forte est obligatoire dans cet espace.'
              : 'La connexion forte est facultative dans cet espace.'}
            {policy.deadline && policy.requireStrongAuth && (
              <> Votre échéance : {new Date(policy.deadline).toLocaleString('fr-FR')}.</>
            )}
            {!policy.contentAllowed && (
              <>
                {' '}
                Pour retrouver vos pages, configurez puis vérifiez un facteur dans « Sécurité du
                compte ».
              </>
            )}
          </p>
          {policy.role === 'owner' ? (
            <form
              className="space-y-5 border-t pt-5"
              onSubmit={(e) => {
                e.preventDefault();
                void run(async () => {
                  await contentRequest(base + '/security', 'PUT', {
                    expectedVersion: policy.version,
                    requireStrongAuth: required,
                    graceDays: days,
                  });
                  setNotice('Politique enregistrée. Les échéances existantes sont conservées.');
                });
              }}
            >
              <h2 className="text-xl font-semibold">Politique de connexion</h2>
              {!policy.recentStrong && (
                <p>
                  Avant de modifier cette politique, vérifiez votre identité dans « Sécurité du
                  compte ». Si aucun facteur n’est configuré, ajoutez-en un, puis vérifiez-le.
                </p>
              )}
              <label className="block">
                <input
                  type="checkbox"
                  checked={required}
                  onChange={(e) => setRequired(e.target.checked)}
                />{' '}
                Exiger un facteur fort
              </label>
              <label className="block">
                Délai de grâce pour les membres déjà présents (jours)
                <input
                  className="field mt-2"
                  type="number"
                  min={0}
                  max={30}
                  required
                  value={days}
                  onChange={(e) => setDays(Number(e.target.value))}
                />
              </label>
              <p>
                À l’activation, les membres déjà présents disposent de ce délai. Les nouveaux
                membres doivent utiliser un facteur dès leur arrivée. Changer cette durée ne
                repousse pas les échéances déjà fixées. Une désactivation ne les efface pas.
              </p>
              <button className="primary" disabled={busy || !policy.recentStrong}>
                Enregistrer la politique
              </button>
            </form>
          ) : (
            <p>Le propriétaire de l’espace gère cette politique.</p>
          )}
          {policy.role === 'owner' && (
            <section className="space-y-4 border-t pt-5">
              <h2 className="text-xl font-semibold">Rôles des membres</h2>
              <p>
                Changer un rôle demande une vérification de moins de dix minutes. L’espace doit
                garder au moins un propriétaire.
              </p>
              {members.map((member) => (
                <div
                  className="flex flex-wrap items-center gap-4 rounded border p-4"
                  key={member.id}
                >
                  <span>
                    {member.name} —{' '}
                    {member.role === 'owner'
                      ? 'Propriétaire'
                      : member.role === 'member'
                        ? 'Membre'
                        : member.role}
                  </span>
                  {['owner', 'member'].includes(member.role) && (
                    <button
                      className="quiet-link"
                      disabled={busy || !policy.recentStrong}
                      onClick={() =>
                        void run(async () => {
                          if (!globalThis.confirm(`Changer le rôle de ${member.name} ?`)) return;
                          await contentRequest(`${base}/members/${member.id}/role`, 'PUT', {
                            expectedRole: member.role,
                            role: member.role === 'owner' ? 'member' : 'owner',
                          });
                          setNotice('Rôle enregistré.');
                        })
                      }
                    >
                      {member.role === 'owner' ? 'Passer membre' : 'Nommer propriétaire'}
                    </button>
                  )}
                  {member.deadline && (
                    <span className="text-sm">
                      Échéance : {new Date(member.deadline).toLocaleString('fr-FR')}
                    </span>
                  )}
                </div>
              ))}
            </section>
          )}
        </>
      )}
    </main>
  );
}
