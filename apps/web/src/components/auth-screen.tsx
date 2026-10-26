'use client';

import Link from 'next/link';
import { useSearchParams } from 'next/navigation';
import { useState } from 'react';
import type { FormEvent } from 'react';
import { authClient, authError } from '../lib/auth-client.ts';
import { securityStatus, securityError } from '../lib/security-client.ts';
import { refreshCachePolicy } from '../lib/cache-policy.ts';
import { pendingInvitation, securityDestination } from '../lib/access-flow.ts';

export function AuthScreen({ mode }: { mode: 'signin' | 'signup' | 'verify' }) {
  const params = useSearchParams();
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState(false);
  const [sharedComputer, setSharedComputer] = useState(false);
  const loginHeaders = { 'x-memoria-shared-computer': String(sharedComputer) };
  function confirmShared() {
    return (
      !sharedComputer ||
      globalThis.confirm(
        'Poste partagé : toutes vos copies locales sur ce navigateur seront effacées, y compris dans les autres onglets. Des changements non envoyés peuvent être perdus. Annulez pour les synchroniser ou les exporter d’abord ; continuez pour confirmer l’effacement.',
      )
    );
  }
  async function finishLogin() {
    const status = await securityStatus();
    await refreshCachePolicy(status.userId, status.sessionId);
    const destination = pendingInvitation() ? '/invitation' : '/';
    globalThis.location.replace(
      status.requiresStrongAuth
        ? destination === '/invitation'
          ? securityDestination(destination)
          : '/securite'
        : destination,
    );
  }
  const title =
    mode === 'signin'
      ? 'Heureux de vous retrouver.'
      : mode === 'signup'
        ? 'Un espace pour vos idées.'
        : 'Vérifiez votre adresse.';

  async function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setError('');
    try {
      if (mode === 'verify' || sent) {
        const result = await authClient.sendVerificationEmail({
          email,
          callbackURL: '/connexion?verified=1',
        });
        if (result.error) setError(authError(result.error.code, result.error.status));
        else setSent(true);
      } else if (mode === 'signup') {
        const result = await authClient.signUp.email({
          name: String(form.get('name')).trim(),
          email,
          password: String(form.get('password')),
          callbackURL: '/connexion?verified=1',
        });
        if (result.error) setError(authError(result.error.code, result.error.status));
        else setSent(true);
      } else {
        if (!confirmShared()) return;
        const result = await authClient.signIn.email({
          email,
          password: String(form.get('password')),
          fetchOptions: { headers: loginHeaders },
        });
        if (result.error) setError(authError(result.error.code, result.error.status));
        // A fresh document drops the previous account's client session and editor state.
        else await finishLogin();
      }
    } catch {
      setError('Le service est momentanément indisponible. Réessayez.');
    } finally {
      setBusy(false);
    }
  }

  return (
    <main className="grid min-h-screen lg:grid-cols-[1fr_1.1fr]">
      <section className="flex flex-col justify-between bg-[#263f33] p-8 text-[#f5f4e9] lg:p-16">
        <Link href="/" className="text-2xl font-semibold tracking-tight">
          m<span className="text-[#d8bc81]">.</span> memoria
        </Link>
        <div className="my-12 max-w-md lg:my-24">
          <p className="mb-5 text-xs font-semibold uppercase tracking-[.22em] text-[#d8bc81]">
            Le carnet de votre studio
          </p>
          <h1 className="text-4xl leading-tight font-medium lg:text-5xl">
            Les grandes idées
            <br />
            commencent ici.
          </h1>
          <p className="mt-6 text-lg leading-relaxed text-[#cbd8ce]">
            Un endroit commun pour donner forme à vos projets, et garder le fil de ce que vous créez
            ensemble.
          </p>
        </div>
        <p className="text-sm text-[#cbd8ce]">Votre studio. Vos idées. Votre mémoire.</p>
      </section>
      <section className="flex items-center justify-center px-6 py-12 lg:p-16">
        <div className="w-full max-w-sm">
          <p className="mb-3 text-xs font-semibold uppercase tracking-[.18em] text-[#78857a]">
            {mode === 'signin'
              ? 'Connexion'
              : mode === 'signup'
                ? 'Créer un compte'
                : 'Vérification'}
          </p>
          <h2 className="mb-7 text-3xl font-semibold tracking-tight">{title}</h2>
          {mode === 'signin' && (
            <p className="mb-5">
              <Link className="quiet-link" href="/recuperation">
                Mot de passe ou facteur perdu ?
              </Link>
            </p>
          )}
          {params.has('error') && (
            <p role="alert" className="notice error mb-5">
              Ce lien est invalide ou a expiré. Demandez un nouveau lien de vérification.
            </p>
          )}
          {params.get('verified') === '1' && !params.has('error') && (
            <p role="status" className="notice mb-5">
              Adresse vérifiée. Vous pouvez maintenant vous connecter.
            </p>
          )}
          {sent && (
            <p role="status" className="notice mb-5">
              Si cette adresse correspond à un compte à vérifier, un email vous attend. Ouvrez le
              lien puis connectez-vous.
            </p>
          )}
          {busy && (
            <p role="status" className="notice mb-5">
              Vérification en cours. Cela peut prendre jusqu’à trente secondes.
            </p>
          )}
          <form onSubmit={submit} className="space-y-5">
            {mode === 'signup' && !sent && (
              <label className="block text-sm font-medium">
                Votre nom
                <input
                  className="field mt-2"
                  name="name"
                  autoComplete="name"
                  maxLength={100}
                  required
                />
              </label>
            )}
            <label className="block text-sm font-medium">
              Adresse email
              <input
                className="field mt-2"
                name="email"
                type="email"
                autoComplete="email"
                value={email}
                onChange={(event) => setEmail(event.target.value)}
                maxLength={254}
                required
              />
            </label>
            {mode !== 'verify' && !sent && (
              <label className="block text-sm font-medium">
                Mot de passe
                <input
                  className="field mt-2"
                  name="password"
                  type="password"
                  autoComplete={mode === 'signup' ? 'new-password' : 'current-password'}
                  minLength={mode === 'signup' ? 12 : 1}
                  maxLength={128}
                  required
                />
                {mode === 'signup' && (
                  <span className="mt-2 block text-xs text-[#657267]">12 caractères minimum.</span>
                )}
              </label>
            )}
            {mode === 'signin' && (
              <label className="block text-sm">
                <input
                  type="checkbox"
                  checked={sharedComputer}
                  disabled={busy}
                  onChange={(event) => setSharedComputer(event.target.checked)}
                />{' '}
                Poste partagé — ne pas conserver mes pages sur cet appareil
              </label>
            )}
            {error && (
              <p role="alert" className="notice error">
                {error}
              </p>
            )}
            <button className="primary w-full" disabled={busy} type="submit">
              {busy
                ? 'Un instant…'
                : sent
                  ? 'Renvoyer le lien'
                  : mode === 'signin'
                    ? 'Se connecter'
                    : mode === 'signup'
                      ? 'Créer mon compte'
                      : 'Envoyer le lien'}
            </button>
          </form>
          {mode === 'signin' && (
            <button
              className="quiet-link mt-5 w-full"
              disabled={busy}
              onClick={() => {
                if (!confirmShared()) return;
                setBusy(true);
                setError('');
                void authClient.signIn
                  .passkey({ fetchOptions: { headers: loginHeaders } })
                  .then(async (result) => {
                    if (result.error)
                      setError(
                        securityError(
                          'code' in result.error ? String(result.error.code) : undefined,
                        ),
                      );
                    else await finishLogin();
                  })
                  .catch(() => setError('La connexion a échoué. Réessayez.'))
                  .finally(() => setBusy(false));
              }}
            >
              Se connecter avec une passkey
            </button>
          )}
          <nav
            className="mt-7 space-y-3 text-center text-sm text-[#57685b]"
            aria-label="Autres options de connexion"
          >
            {mode === 'signin' ? (
              <>
                <p>
                  Pas encore de compte ?{' '}
                  <Link className="quiet-link" href="/inscription">
                    Créer un compte
                  </Link>
                </p>
                <p>
                  <Link className="quiet-link" href="/verification">
                    Renvoyer un email de vérification
                  </Link>
                </p>
              </>
            ) : (
              <p>
                <Link className="quiet-link" href="/connexion">
                  Revenir à la connexion
                </Link>
              </p>
            )}
          </nav>
        </div>
      </section>
    </main>
  );
}
