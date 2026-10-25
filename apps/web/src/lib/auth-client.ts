'use client';
import { createAuthClient } from 'better-auth/react';
import { passkeyClient } from '@better-auth/passkey/client';

export const authClient = createAuthClient({
  basePath: '/api/auth',
  plugins: [passkeyClient()],
  fetchOptions: { credentials: 'include' },
});

export function authError(code?: string, status?: number): string {
  if (status === 429 || code === 'TOO_MANY_REQUESTS')
    return 'Trop de tentatives. Patientez avant de réessayer.';
  switch (code) {
    case 'EMAIL_NOT_VERIFIED':
      return 'Vérifiez votre adresse email avant de vous connecter.';
    case 'INVALID_EMAIL_OR_PASSWORD':
      return 'Email ou mot de passe incorrect.';
    case 'USER_ALREADY_EXISTS':
    case 'USER_ALREADY_EXISTS_USE_ANOTHER_EMAIL':
      return 'Cette adresse est déjà utilisée. Connectez-vous ou renvoyez le lien de vérification.';
    default:
      return 'La demande n’a pas abouti. Vérifiez votre connexion et réessayez.';
  }
}
