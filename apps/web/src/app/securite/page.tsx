'use client';
import Link from 'next/link';
import { useEffect, useState } from 'react';
import type { FormEvent } from 'react';
import { authClient } from '../../lib/auth-client.ts';
import { securityError, securityRequest, securityStatus } from '../../lib/security-client.ts';
import type { SecurityStatus } from '../../lib/security-client.ts';
import { onLocalSignOut, signOutAndClear } from '../../lib/local-sign-out.ts';
import { TotpQr } from '../../components/totp-qr.tsx';
import { accessReturnPath } from '../../lib/access-flow.ts';

export default function SecurityPage() {
  const [status, setStatus] = useState<SecurityStatus>();
  const [returnTo, setReturnTo] = useState<string | null>(null);
  useEffect(() => {
    setReturnTo(accessReturnPath(new URL(globalThis.location.href).searchParams.get('returnTo')));
  }, []);
  const [busy, setBusy] = useState(false),
    [error, setError] = useState(''),
    [notice, setNotice] = useState('');
  const [uri, setUri] = useState(''),
    [codes, setCodes] = useState<string[]>([]);
  const [password, setPassword] = useState(''),
    [code, setCode] = useState(''),
    [name, setName] = useState('');
  const [confirmLogout, setConfirmLogout] = useState(false);
  async function refresh() {
    setStatus(await securityStatus());
  }
  useEffect(() => {
    if (!status?.userId) return;
    return onLocalSignOut(status.userId, () => {
      setCodes([]);
      setUri('');
      setPassword('');
      setCode('');
      setStatus(undefined);
      setError('Déconnexion demandée sur ce navigateur.');
    });
  }, [status?.userId]);
  useEffect(() => {
    let active = true;
    void authClient
      .getSession()
      .then(async (result) => {
        if (!result.data) {
          globalThis.location.replace('/connexion');
          return;
        }
        const next = await securityStatus();
        if (active) setStatus(next);
      })
      .catch(() => {
        if (active) setError('Impossible de lire la sécurité du compte. Réessayez.');
      });
    return () => {
      active = false;
    };
  }, []);
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await action();
    } catch (cause) {
      setError(cause instanceof Error ? cause.message : 'La demande a échoué.');
    } finally {
      setBusy(false);
    }
  }
  function saveCodes(data: unknown) {
    const values = (data as { recoveryCodes?: unknown })?.recoveryCodes;
    if (Array.isArray(values) && values.every((value) => typeof value === 'string'))
      setCodes(values);
  }
  async function signOut() {
    if (!status) return;
    setCodes([]);
    setUri('');
    setPassword('');
    setCode('');
    const result = await signOutAndClear(status.userId, status.sessionId, async () => {
      const response = await authClient.signOut();
      if (response.error) throw new Error('Déconnexion impossible.');
    });
    if (!result.cacheCleared || !result.serverSignedOut)
      throw new Error(
        'Le nettoyage ou la fermeture a échoué. Réessayez avant de quitter ce poste.',
      );
    globalThis.location.replace('/connexion');
  }
  async function verifyTotp(event: FormEvent) {
    event.preventDefault();
    await run(async () => {
      const challenge = await securityRequest('/security/challenge', {});
      const result = await securityRequest(
        '/two-factor/verify-totp',
        { code },
        { 'x-memoria-challenge': String(challenge.id) },
      );
      saveCodes(result);
      setCode('');
      setUri('');
      setPassword('');
      await refresh();
      setNotice(
        result.enrollmentComplete
          ? status?.recovery
            ? 'Application de codes ajoutée. Terminez la récupération pour obtenir vos nouveaux codes de secours.'
            : 'Facteur ajouté. Conservez vos codes de secours, puis vérifiez votre identité avec le prochain code.'
          : 'Identité vérifiée. Vous pouvez accéder à vos espaces.',
      );
    });
  }
  async function verifyPasskey() {
    await run(async () => {
      const result = await authClient.signIn.passkey();
      if (result.error)
        throw new Error(
          securityError('code' in result.error ? String(result.error.code) : undefined),
        );
      await refresh();
      setNotice('Identité vérifiée avec votre passkey.');
    });
  }
  async function removeLostFactor(factor: string) {
    if (
      !globalThis.confirm(
        'Retirer ce facteur perdu ? Vos espaces resteront fermés pendant la récupération.',
      )
    )
      return;
    await securityRequest('/security/recovery-remove-factor', { factor });
    setUri('');
    await refresh();
  }
  const setupSecret = uri ? new URL(uri).searchParams.get('secret') : '';
  return (
    <main className="mx-auto max-w-2xl space-y-8 px-6 py-10">
      <header className="flex flex-wrap items-center justify-between gap-4">
        <h1 className="text-3xl font-semibold">Sécurité du compte</h1>
        {status && !status.requiresStrongAuth && (
          <Link className="quiet-link" href="/">
            Mes espaces
          </Link>
        )}
      </header>
      <Link className="quiet-link" href="/recuperation">
        Mot de passe ou facteur perdu ?
      </Link>
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
      {!status ? (
        <button className="primary" disabled={busy} onClick={() => void run(refresh)}>
          Charger la sécurité du compte
        </button>
      ) : (
        <>
          <section className="notice">
            <p>
              {status.recovery
                ? 'Récupération en cours, limitée à quinze minutes. Retirez le facteur perdu, ajoutez-en un nouveau, puis terminez la récupération.'
                : status.recoveryRequired && !status.passkeys.length && !status.totpEnabled
                  ? 'Un rétablissement de vos facteurs est nécessaire. Utilisez votre code de secours ou le lien envoyé par votre exploitant.'
                  : status.requiresStrongAuth
                    ? 'Vérifiez votre identité pour ouvrir vos espaces.'
                    : status.strong
                      ? 'Vous êtes connecté avec un facteur fort.'
                      : 'Vous êtes connecté avec votre mot de passe.'}
            </p>
            {status.strong && !status.recent && (
              <p className="mt-2">
                Une nouvelle vérification est nécessaire pour modifier vos facteurs.
              </p>
            )}
          </section>
          {returnTo && (
            <section className="notice space-y-3" aria-label="Reprendre votre action">
              <p>
                {returnTo.endsWith('/acces')
                  ? 'Pour gérer les accès au studio, ajoutez une seconde vérification à votre compte, puis vérifiez votre identité.'
                  : 'Ce studio protège ses documents avec une seconde vérification. Ajoutez une clé d’accès ou une application de codes, puis vérifiez votre identité pour continuer.'}
              </p>
              <p>
                La configuration seule ne suffit pas : vérifiez ensuite un code ou utilisez votre
                clé d’accès.
              </p>
              {status.recent && codes.length === 0 && (
                <a className="primary inline-block" href={returnTo}>
                  Reprendre mon action
                </a>
              )}
            </section>
          )}
          {codes.length > 0 && (
            <section
              className="rounded-xl border border-[#b58641] p-5"
              aria-label="Codes de secours"
            >
              <h2 className="text-xl font-semibold">Conservez ces dix codes de secours</h2>
              <p className="mt-2">
                Ils ne seront plus affichés. Chaque code ne sert qu’une fois, pour rétablir vos
                facteurs. Gardez-les dans un endroit sûr, hors de ce poste.
              </p>
              <pre className="my-4 overflow-x-auto text-sm">{codes.join('\n')}</pre>
              <button
                className="quiet-link mr-6"
                onClick={() => {
                  const url = URL.createObjectURL(
                    new Blob([codes.join('\n')], { type: 'text/plain' }),
                  );
                  const link = document.createElement('a');
                  link.href = url;
                  link.download = 'memoria-codes-de-secours.txt';
                  link.click();
                  URL.revokeObjectURL(url);
                }}
              >
                Télécharger les codes
              </button>
              <button className="primary" onClick={() => setCodes([])}>
                J’ai conservé mes codes
              </button>
            </section>
          )}
          {((status.totpEnabled && !status.recovery) || status.totpPending) && (
            <section className="space-y-4" aria-label="Vérifier un code">
              <h2 className="text-xl font-semibold">
                {status.totpPending
                  ? 'Terminer la configuration'
                  : 'Vérifier votre identité par code'}
              </h2>
              {uri && (
                <div className="notice">
                  <p>Scannez ce QR code avec votre application d’authentification.</p>
                  <TotpQr uri={uri} />
                  <p>
                    Vous pouvez aussi ajouter un compte avec cette clé (six chiffres, toutes les
                    trente secondes).
                  </p>
                  <code className="mt-3 block break-all select-all">{setupSecret}</code>
                </div>
              )}
              {status.totpPending && !uri && (
                <p>
                  Utilisez la clé déjà affichée. Si vous ne l’avez pas conservée, recommencez la
                  configuration ci-dessous.
                </p>
              )}
              <form onSubmit={verifyTotp} className="flex flex-wrap items-end gap-3">
                <label>
                  Code de l’application
                  <input
                    className="field mt-2"
                    value={code}
                    onChange={(e) => setCode(e.target.value)}
                    inputMode="numeric"
                    autoComplete="one-time-code"
                    pattern="[0-9]{6}"
                    maxLength={6}
                    required
                  />
                </label>
                <button className="primary" disabled={busy}>
                  Vérifier le code
                </button>
              </form>
            </section>
          )}
          {status.passkeys.length > 0 && !status.recovery && (
            <button className="primary" disabled={busy} onClick={() => void verifyPasskey()}>
              Vérifier avec une passkey
            </button>
          )}
          {(!status.requiresStrongAuth || status.recovery) && (
            <section className="space-y-4 border-t pt-6">
              <h2 className="text-xl font-semibold">Ajouter un facteur</h2>
              <p>
                Un facteur actif sera demandé lors des prochaines connexions. Son ajout ferme les
                autres sessions. Vérifiez d’abord que vos autres pages sont enregistrées sur le
                serveur.
              </p>
              <label className="block">
                Mot de passe actuel
                <input
                  className="field mt-2"
                  type="password"
                  autoComplete="current-password"
                  value={password}
                  onChange={(e) => setPassword(e.target.value)}
                  maxLength={128}
                />
              </label>
              <button
                className="quiet-link"
                disabled={busy || !password}
                onClick={() =>
                  void run(async () => {
                    await securityRequest('/verify-password', { password });
                    setPassword('');
                    setNotice('Mot de passe confirmé pour cinq minutes.');
                  })
                }
              >
                Confirmer le mot de passe
              </button>
              {!status.totpEnabled && (
                <div>
                  <button
                    className="primary"
                    disabled={busy || !password}
                    onClick={() =>
                      void run(async () => {
                        const result = await securityRequest('/two-factor/enable', { password });
                        setUri(String(result.totpURI));
                        setPassword('');
                        await refresh();
                      })
                    }
                  >
                    {status.totpPending
                      ? 'Recommencer la configuration par code'
                      : 'Configurer une application de codes'}
                  </button>
                </div>
              )}
              <label className="block">
                Nom de la passkey
                <input
                  className="field mt-2"
                  placeholder="Mon ordinateur, ma clé…"
                  maxLength={100}
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </label>
              <button
                className="primary"
                disabled={busy}
                onClick={() =>
                  void run(async () => {
                    const result = await authClient.passkey.addPasskey({
                      name: name.trim() || 'Ma passkey',
                    });
                    if (result.error)
                      throw new Error(
                        securityError(
                          'code' in result.error ? String(result.error.code) : undefined,
                        ),
                      );
                    saveCodes(result.data);
                    setName('');
                    await refresh();
                    setNotice(
                      status.recovery
                        ? 'Passkey ajoutée. Terminez la récupération pour obtenir vos nouveaux codes de secours.'
                        : 'Passkey ajoutée. Vérifiez maintenant votre identité avec elle.',
                    );
                  })
                }
              >
                Ajouter une passkey
              </button>
              <p className="text-sm">
                Votre appareil ou votre clé doit demander un code PIN ou la biométrie. Une clé sans
                cette vérification ne convient pas.
              </p>
            </section>
          )}
          {status.recovery && (
            <section className="space-y-4 border-t pt-6" aria-label="Terminer la récupération">
              {status.totpEnabled && (
                <button
                  className="quiet-link"
                  disabled={busy}
                  onClick={() => void run(() => removeLostFactor('totp'))}
                >
                  Retirer l’application de codes perdue
                </button>
              )}
              {status.passkeys.map((key) => (
                <div key={key.id}>
                  <button
                    className="quiet-link"
                    disabled={busy}
                    onClick={() => void run(() => removeLostFactor('passkey:' + key.id))}
                  >
                    Retirer la passkey perdue : {key.name ?? 'Passkey'}
                  </button>
                </div>
              ))}
              <button
                className="primary"
                disabled={busy || !status.recoveryFactorReady}
                onClick={() =>
                  void run(async () => {
                    saveCodes(await securityRequest('/security/recovery-finish', {}));
                    await refresh();
                    setNotice(
                      'Récupération terminée. Conservez les nouveaux codes : ils remplacent les anciens. Vérifiez maintenant votre identité avec le nouveau facteur.',
                    );
                  })
                }
              >
                Terminer la récupération
              </button>
            </section>
          )}
          <section className="space-y-4 border-t pt-6">
            <h2 className="text-xl font-semibold">Vos facteurs</h2>
            <p>
              Application de codes :{' '}
              {status.totpEnabled
                ? 'activée'
                : status.totpPending
                  ? 'configuration en cours'
                  : 'non configurée'}
              .
            </p>
            {status.passkeys.map((key) => (
              <div key={key.id} className="rounded border p-4">
                <form
                  className="flex flex-wrap gap-3"
                  onSubmit={(e) => {
                    e.preventDefault();
                    const nextName = String(new FormData(e.currentTarget).get('name'));
                    void run(async () => {
                      await securityRequest('/passkey/update-passkey', {
                        id: key.id,
                        name: nextName,
                      });
                      await refresh();
                    });
                  }}
                >
                  <input
                    className="field"
                    aria-label="Nom de la passkey enregistrée"
                    name="name"
                    defaultValue={key.name ?? 'Passkey'}
                    maxLength={100}
                    required
                  />
                  <button className="quiet-link" disabled={busy || !status.recent}>
                    Renommer
                  </button>
                </form>
                <button
                  className="quiet-link mt-3"
                  disabled={busy || !status.recent}
                  onClick={() =>
                    void run(async () => {
                      if (
                        !globalThis.confirm(
                          'Supprimer cette passkey et fermer toutes vos sessions ?',
                        )
                      )
                        return;
                      await securityRequest('/passkey/delete-passkey', { id: key.id });
                      await signOut();
                    })
                  }
                >
                  Supprimer cette passkey
                </button>
              </div>
            ))}
            {status.totpEnabled && (
              <form
                onSubmit={(e) => {
                  e.preventDefault();
                  const pwd = String(new FormData(e.currentTarget).get('password'));
                  void run(async () => {
                    if (!globalThis.confirm('Désactiver les codes et fermer toutes vos sessions ?'))
                      return;
                    await securityRequest('/two-factor/disable', { password: pwd });
                    await signOut();
                  });
                }}
                className="space-y-3"
              >
                <label className="block">
                  Mot de passe pour désactiver les codes
                  <input
                    className="field mt-2"
                    name="password"
                    type="password"
                    autoComplete="current-password"
                    required
                    maxLength={128}
                  />
                </label>
                <button className="quiet-link" disabled={busy || !status.recent}>
                  Désactiver l’application de codes
                </button>
              </form>
            )}
            {(status.totpEnabled || status.passkeys.length > 0) && (
              <div>
                <p>Codes de secours disponibles : {status.recoveryCodesRemaining}.</p>
                <button
                  className="quiet-link mt-2"
                  disabled={busy || !status.recent}
                  onClick={() =>
                    void run(async () => {
                      if (!globalThis.confirm('Remplacer tous vos anciens codes de secours ?'))
                        return;
                      saveCodes(await securityRequest('/security/recovery-codes', {}));
                      await refresh();
                    })
                  }
                >
                  Créer de nouveaux codes de secours
                </button>
              </div>
            )}
          </section>
          <section className="border-t pt-6">
            {!confirmLogout ? (
              <button className="quiet-link" onClick={() => setConfirmLogout(true)}>
                Se déconnecter
              </button>
            ) : (
              <>
                <p className="notice">
                  La déconnexion efface les copies locales et les changements hors ligne non envoyés
                  dans tous les onglets. Revenez à vos pages pour les synchroniser ou les exporter
                  avant de continuer.
                </p>
                <button
                  className="primary mt-3 mr-4"
                  disabled={busy}
                  onClick={() => void run(signOut)}
                >
                  Effacer les copies et se déconnecter
                </button>
                <button className="quiet-link" onClick={() => setConfirmLogout(false)}>
                  Annuler
                </button>
              </>
            )}
          </section>
        </>
      )}
    </main>
  );
}
