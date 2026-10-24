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
    const message =
      code === 'DOCUMENT_RESET_REQUIRED'
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
                  : 'La requête a échoué. Réessayez.';
    throw new ContentError(response.status, code, message);
  }
  return response.json();
}
