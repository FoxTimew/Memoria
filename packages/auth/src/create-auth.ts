import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import * as schema from '@memoria/db/schema';
import type { Database, WriteTransaction } from '@memoria/db';
import { securityIntegration } from './security-plugin.ts';
import type { SecurityFlow } from './security-plugin.ts';
import { queueAuthMail } from './recovery-core.ts';

export interface AuthOptions {
  origin: string;
  secret: string;
  sendVerificationEmail?(email: string, url: string): Promise<void>;
  /** Only the mail worker sets this after consuming the request's destination budget. */
  mailBudgetGranted?: boolean;
  /** Server-only request scope, constructed by handleAuthRequest inside a transaction. */
  securityFlow?: SecurityFlow;
}

export function createAuth(database: Database | WriteTransaction, options: AuthOptions) {
  const security = securityIntegration(
    database,
    options.origin,
    options.securityFlow,
    options.secret,
  );
  return betterAuth({
    appName: 'Memoria',
    baseURL: options.origin,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [options.origin],
    hooks: security.hooks,
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    logger: { disabled: true },
    // Let our transaction boundary handle unknown errors without logging SQL parameters.
    onAPIError: { throw: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
      resetPasswordTokenExpiresIn: 1800,
      revokeSessionsOnPasswordReset: true,
      sendResetPassword: async ({ user, token }) => {
        if (user.emailVerified)
          await queueAuthMail(
            database,
            options.secret,
            'delivery',
            {
              email: user.email,
              subject: 'Changer votre mot de passe — Memoria',
              text: `Pour choisir un nouveau mot de passe, ouvrez ce lien sous trente minutes :\n${options.origin}/recuperation#reset=${token}\nSi vous n’avez rien demandé, ignorez cet email.`,
            },
            user.id,
            undefined,
            options.mailBudgetGranted ? false : 'password',
          );
      },
      onPasswordReset: async ({ user }) => security.passwordReset(user.id),
    },
    verification: {
      storeIdentifier: { default: 'plain', overrides: { 'reset-password:': 'hashed' } },
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) =>
        options.sendVerificationEmail
          ? options.sendVerificationEmail(user.email, url)
          : queueAuthMail(
              database,
              options.secret,
              'delivery',
              {
                email: user.email,
                subject: 'Vérifiez votre adresse email — Memoria',
                text: `Confirmez votre adresse email avec ce lien valable une heure :\n${url}`,
              },
              user.id,
              undefined,
              options.mailBudgetGranted ? false : 'verification',
            ),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    // Fixed-window admission belongs to the HTTP facade, before the auth transaction.
    // This also removes hidden plugin ceilings incompatible with an office NAT.
    rateLimit: { enabled: false },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: true,
      cookiePrefix: 'memoria',
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
      // The API overwrites this header using Express's trusted-proxy resolution.
      ipAddress: { ipAddressHeaders: ['x-memoria-client-ip'] },
    },
    plugins: [
      security.totpPlugin,
      security.passkeyPlugin,
      security.plugin,
      organization({
        creatorRole: 'owner',
        roles: { owner: ownerAc, member: memberAc },
        allowUserToCreateOrganization: async (user) => user.emailVerified,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
