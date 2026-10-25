'use client';
export interface SecurityStatus {
  userId: string;
  sessionId: string;
  strong: boolean;
  recent: boolean;
  requiresStrongAuth: boolean;
  recovery: boolean;
  recoveryRequired: boolean;
  recoveryFactorReady: boolean;
  verifiedAt: string | null;
  method: string | null;
  totpEnabled: boolean;
  totpPending: boolean;
  recoveryCodesRemaining: number;
  passkeys: { id: string; name: string | null; createdAt: string }[];
}
export function securityError(code?: string) {
  switch (code) {
    case 'RECOVERY_DENIED':
      return 'L’adresse, le mot de passe ou l’autorisation de récupération est incorrect, expiré ou déjà utilisé.';
    case 'INVALID_TOKEN':
    case 'INVALID_RESET_TOKEN':
      return 'Ce lien est invalide, expiré ou déjà utilisé. Demandez un nouveau lien.';
    case 'RECOVERY_REQUIRED':
      return 'Utilisez un code de secours ou le lien de récupération envoyé par votre exploitant.';
    case 'NEW_FACTOR_REQUIRED':
    case 'RECOVERY_FINISH_REQUIRED':
      return 'Configurez un nouveau facteur, puis terminez la récupération avant de vérifier votre identité.';
    case 'RECENT_PASSWORD_REQUIRED':
      return 'Confirmez votre mot de passe avant d’ajouter un facteur.';
    case 'RECENT_STRONG_AUTH_REQUIRED':
      return 'Vérifiez à nouveau votre identité avec un code ou une passkey.';
    case 'TOTP_ALREADY_USED':
      return 'Ce code a déjà servi. Attendez le prochain code de votre application.';
    case 'INVALID_CODE':
      return 'Code incorrect. Vérifiez votre application et l’heure de votre appareil.';
    case 'CHALLENGE_EXHAUSTED_OR_EXPIRED':
      return 'Cette vérification a expiré ou ses cinq essais sont épuisés. Patientez cinq minutes ou reconnectez-vous.';
    case 'USER_VERIFICATION_REQUIRED':
      return 'Cette passkey doit utiliser un code PIN ou la biométrie. Choisissez une clé compatible.';
    case 'LAST_FACTOR_REQUIRED':
      return 'Votre espace exige un facteur. Ajoutez-en un autre avant de supprimer celui-ci.';
    case 'SESSION_NOT_FRESH':
      return 'Reconnectez-vous avant d’ajouter cette passkey.';
    case 'TOO_MANY_REQUESTS':
      return 'Trop de tentatives. Patientez avant de réessayer.';
    case 'AUTH_CANCELLED':
    case 'ERROR_CEREMONY_ABORTED':
      return 'Vérification annulée. Vous pouvez réessayer.';
    default:
      return 'La vérification n’a pas abouti. Réessayez ou reconnectez-vous.';
  }
}
export async function securityRequest(
  path: string,
  body?: unknown,
  headers: Record<string, string> = {},
) {
  const response = await fetch(`/api/auth${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    credentials: 'include',
    cache: 'no-store',
    headers: { 'Content-Type': 'application/json', ...headers },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const data = (await response.json()) as Record<string, unknown>;
  if (response.status === 429) {
    const wait = Number(response.headers.get('Retry-After'));
    throw new Error(
      Number.isFinite(wait) && wait > 0
        ? `Patientez ${Math.ceil(wait)} secondes avant de réessayer.`
        : securityError('TOO_MANY_REQUESTS'),
    );
  }
  if (!response.ok)
    throw new Error(
      securityError(response.status === 429 ? 'TOO_MANY_REQUESTS' : String(data.code)),
    );
  return data;
}
export async function securityStatus() {
  return (await securityRequest('/security/status')) as unknown as SecurityStatus;
}
