import { VersionConflict } from './page-draft.ts';
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
  if (response.status === 409) throw new VersionConflict('La page a été modifiée ailleurs.');
  if (response.status === 401)
    throw new Error('Session expirée. Reconnectez-vous ; votre brouillon reste affiché.');
  if (response.status === 404)
    throw new Error(
      'Page ou espace inaccessible. Il a peut-être été archivé ou votre accès a changé.',
    );
  if (response.status === 413)
    throw new Error('La modification dépasse 1 Mo. Réduisez le contenu avant de réessayer.');
  if (!response.ok) {
    const result: unknown = await response.json().catch(() => null);
    throw new Error(
      result &&
        typeof result === 'object' &&
        'message' in result &&
        typeof result.message === 'string'
        ? result.message
        : 'La requête a échoué. Réessayez.',
    );
  }
  return response.json();
}
