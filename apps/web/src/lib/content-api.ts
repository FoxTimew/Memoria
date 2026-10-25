export class ContentError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}
export async function contentRequest(
  path: string,
  method = 'GET',
  body?: unknown,
): Promise<unknown> {
  const response = await globalThis.fetch(path, {
    method,
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    const code =
      result && typeof result === 'object' && 'code' in result && typeof result.code === 'string'
        ? result.code
        : 'REQUEST_FAILED';
    const accessMessages: Record<string, string> = {
      INVITATION_UNAVAILABLE:
        'Cette invitation est expirée, remplacée ou inaccessible avec ce compte.',
      INVALID_ACCESS_REQUEST: 'Vérifiez les champs et les pages choisies.',
      ALREADY_MEMBER: 'Cette personne appartient déjà au studio. Utilisez la gestion des membres.',
      ALREADY_INVITED: 'Une invitation est déjà en attente pour cette adresse.',
      INVITATION_CAPACITY: 'Le studio a atteint sa limite de membres ou d’invitations en attente.',
      SHARE_CAPACITY: 'La limite de pages partagées est atteinte.',
      INVITATION_PAGES_CHANGED:
        'Une page choisie a été archivée ou retirée. Demandez une nouvelle invitation.',
      INVITATION_MAIL_LIMITED: 'La limite d’envoi du studio est atteinte. Réessayez plus tard.',
      ROLE_UNCHANGED: 'Choisissez un rôle différent.',
      MEMBER_UNAVAILABLE: 'Cette personne n’appartient plus au studio.',
      ACCESS_VERSION_CONFLICT:
        'Les partages ont changé ailleurs. Vérifiez les accès actualisés et confirmez à nouveau.',
      ACCESS_PREVIEW_STALE:
        'La page ou ses accès ont changé. Demandez un nouvel aperçu avant de confirmer.',
    };
    const message =
      response.status === 429
        ? `Trop de demandes. Réessayez dans ${Number(response.headers.get('Retry-After')) || 60} secondes.`
        : (accessMessages[code] ??
          (code === 'RECENT_STRONG_AUTH_REQUIRED'
            ? 'Vérifiez à nouveau votre identité dans Sécurité du compte, puis réessayez.'
            : ['WORKSPACE_STRONG_AUTH_REQUIRED', 'STRONG_AUTH_REQUIRED'].includes(code)
              ? 'Cet accès exige une connexion forte. Ouvrez Sécurité du compte pour configurer ou vérifier un facteur.'
              : code === 'OWNER_REQUIRED'
                ? 'Cette action est réservée au propriétaire de l’espace.'
                : code === 'LAST_OWNER'
                  ? 'L’espace doit conserver au moins un propriétaire.'
                  : ['SECURITY_VERSION_CONFLICT', 'ROLE_CONFLICT'].includes(code)
                    ? 'Ces réglages ont changé ailleurs. Actualisez avant de réessayer.'
                    : code === 'DOCUMENT_RESET_REQUIRED'
                      ? 'Cette page de test doit être réinitialisée pour ouvrir l’éditeur collaboratif. Consultez le guide de transition 3b.'
                      : response.status === 409
                        ? 'La page a été modifiée ailleurs. Relisez le titre avant de réessayer.'
                        : response.status === 401
                          ? 'Session expirée. Reconnectez-vous.'
                          : [403, 404].includes(response.status)
                            ? 'Page ou espace inaccessible : votre accès a changé ou la page est archivée.'
                            : response.status === 413
                              ? 'La modification dépasse la taille autorisée.'
                              : response.status === 503
                                ? 'Le service est momentanément indisponible. Réessayez.'
                                : 'La requête a échoué. Réessayez.'));
    throw new ContentError(response.status, code, message);
  }
  return response.json();
}
