const prefix = 'memoria-access-flow:';
const pendingKey = prefix + 'invitation';
const uuid = '[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}';
/** Only our fixed destinations; never navigate to an arbitrary client-supplied returnTo. */
export function accessReturnPath(value: string | null) {
  return value === '/invitation' ||
    new RegExp(`^/workspaces/${uuid}/(?:acces|arrivee|securite)$`, 'i').test(value ?? '')
    ? value
    : null;
}
export function pendingInvitation(value?: string | null) {
  try {
    if (value === null) sessionStorage.removeItem(pendingKey);
    else if (value && new RegExp(`^${uuid}$`, 'i').test(value))
      sessionStorage.setItem(pendingKey, value);
    const result = sessionStorage.getItem(pendingKey);
    return result && new RegExp(`^${uuid}$`, 'i').test(result) ? result : null;
  } catch {
    return null;
  }
}
export function clearAccessFlows() {
  try {
    for (const key of Object.keys(sessionStorage))
      if (key.startsWith(prefix)) sessionStorage.removeItem(key);
  } catch {
    /* No persisted flow if storage is unavailable. */
  }
}
export function accessDraft(user: string, workspace: string, value?: unknown) {
  const key = prefix + user + ':' + workspace;
  try {
    if (value === null) sessionStorage.removeItem(key);
    else if (value !== undefined) sessionStorage.setItem(key, JSON.stringify(value));
    return JSON.parse(sessionStorage.getItem(key) ?? 'null') as unknown;
  } catch {
    return null;
  }
}
export const securityDestination = (path: string) =>
  `/securite?returnTo=${encodeURIComponent(accessReturnPath(path) ?? '/invitation')}`;
