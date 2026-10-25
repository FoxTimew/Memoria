'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { securityRequest } from '../lib/security-client.ts';

export function RecoveryScreen() {
  const [mode, setMode] = useState<'email' | 'reset' | 'code' | 'operator'>('email');
  const [ready, setReady] = useState(false);
  const [token, setToken] = useState(''),
    [email, setEmail] = useState(''),
    [password, setPassword] = useState(''),
    [code, setCode] = useState('');
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  useEffect(() => {
    // Fragment is never sent to Caddy/Next or in a Referer. Remove it from history immediately.
    function takeFragment() {
      const fragment = new URLSearchParams(globalThis.location.hash.slice(1));
      const reset = fragment.get('reset'),
        operator = fragment.get('operator');
      if (reset || operator) {
        setMode(reset ? 'reset' : 'operator');
        setToken(reset ?? operator ?? '');
      }
      if (globalThis.location.hash)
        globalThis.history.replaceState(globalThis.history.state, '', '/recuperation');
    }
    takeFragment();
    setReady(true);
    globalThis.addEventListener('hashchange', takeFragment);
    return () => globalThis.removeEventListener('hashchange', takeFragment);
  }, []);
  async function submit(event: FormEvent) {
    event.preventDefault();
    setBusy(true);
    setError('');
    setNotice('');
    try {
      if (mode === 'email') {
        await securityRequest('/security/request-password-reset', { email });
        setNotice(
          'Si cette adresse correspond à un compte vérifié, vous recevrez un email. Consultez aussi les courriers indésirables.',
        );
      } else if (mode === 'reset') {
        await securityRequest('/reset-password', { token, newPassword: password });
        setToken('');
        setPassword('');
        setMode('email');
        setNotice(
          'Votre mot de passe est changé et vos anciennes connexions sont fermées. Connectez-vous à nouveau : votre code habituel ou votre passkey reste nécessaire si vous en avez configuré un.',
        );
      } else {
        await securityRequest(
          mode === 'operator' ? '/security/operator-recover' : '/security/recover',
          { email, password, code: mode === 'operator' ? token : code },
        );
        setPassword('');
        setToken('');
        setCode('');
        globalThis.location.replace('/securite');
      }
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'La demande a échoué.');
    } finally {
      setBusy(false);
    }
  }
  return (
    <main className="mx-auto max-w-lg space-y-6 px-6 py-12">
      <h1 className="text-3xl font-semibold">Récupérer votre accès</h1>
      <p>
        {mode === 'reset'
          ? 'Choisissez un nouveau mot de passe de 12 à 128 caractères.'
          : mode === 'email'
            ? 'Recevez un lien pour choisir un nouveau mot de passe.'
            : 'Utilisez votre mot de passe et votre autorisation de récupération. Vous aurez quinze minutes pour configurer un nouveau moyen de vérifier votre identité ; vos espaces resteront fermés jusque-là.'}
      </p>
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
      <form onSubmit={submit} className="space-y-4">
        <fieldset disabled={!ready || busy} className="space-y-4">
          {mode !== 'reset' && (
            <label className="block">
              Adresse email
              <input
                className="field mt-2"
                type="email"
                autoComplete="email"
                required
                maxLength={254}
                value={email}
                onChange={(e) => setEmail(e.target.value)}
              />
            </label>
          )}
          {mode !== 'email' && (
            <label className="block">
              {mode === 'reset' ? 'Nouveau mot de passe' : 'Mot de passe actuel'}
              <input
                className="field mt-2"
                type="password"
                autoComplete={mode === 'reset' ? 'new-password' : 'current-password'}
                required
                minLength={mode === 'reset' ? 12 : 1}
                maxLength={128}
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </label>
          )}
          {mode === 'code' && (
            <label className="block">
              Code de secours
              <input
                className="field mt-2"
                autoComplete="off"
                spellCheck={false}
                required
                maxLength={128}
                value={code}
                onChange={(e) => setCode(e.target.value)}
              />
            </label>
          )}
          <button className="primary" disabled={busy}>
            {mode === 'email'
              ? 'Envoyer le lien'
              : mode === 'reset'
                ? 'Changer le mot de passe'
                : 'Rétablir mes facteurs'}
          </button>
        </fieldset>
      </form>
      {mode === 'email' && (
        <button
          className="quiet-link"
          onClick={() => {
            setMode('code');
            setNotice('');
            setError('');
          }}
        >
          J’ai perdu mon facteur : utiliser un code de secours
        </button>
      )}
      {mode !== 'email' && (
        <button
          className="quiet-link"
          disabled={busy}
          onClick={() => {
            setMode('email');
            setToken('');
            setPassword('');
            setCode('');
            setError('');
          }}
        >
          Mot de passe oublié : demander un nouveau lien
        </button>
      )}
      <p className="text-sm">
        Sans code de secours ni moyen de vérifier votre identité, contactez l’exploitant de votre
        installation. Le propriétaire d’un espace ne peut pas réinitialiser vos facteurs.
      </p>
      <Link className="quiet-link" href="/connexion">
        Retour à la connexion
      </Link>
    </main>
  );
}
