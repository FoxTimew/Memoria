import { betterAuth } from 'better-auth';
import { drizzleAdapter } from 'better-auth/adapters/drizzle';
import { organization } from 'better-auth/plugins';
import { memberAc, ownerAc } from 'better-auth/plugins/organization/access';
import * as schema from '@memoria/db/schema';
import type { Database, WriteTransaction } from '@memoria/db';

export interface AuthOptions {
  origin: string;
  secret: string;
  sendVerificationEmail(email: string, url: string): Promise<void>;
}

/** Session 1: no strong-auth plugins or session_assurance writes. */
export function createAuth(database: Database | WriteTransaction, options: AuthOptions) {
  return betterAuth({
    appName: 'Memoria',
    baseURL: options.origin,
    basePath: '/api/auth',
    secret: options.secret,
    trustedOrigins: [options.origin],
    database: drizzleAdapter(database, { provider: 'pg', schema }),
    logger: { disabled: true },
    emailAndPassword: {
      enabled: true,
      requireEmailVerification: true,
      autoSignIn: false,
      minPasswordLength: 12,
      maxPasswordLength: 128,
    },
    emailVerification: {
      sendOnSignUp: true,
      sendOnSignIn: false,
      autoSignInAfterVerification: false,
      expiresIn: 3600,
      sendVerificationEmail: async ({ user, url }) =>
        options.sendVerificationEmail(user.email, url),
    },
    session: {
      expiresIn: 60 * 60 * 24 * 7,
      updateAge: 60 * 60 * 24,
      cookieCache: { enabled: false },
    },
    rateLimit: {
      enabled: true,
      storage: 'database',
      window: 60,
      max: 100,
      // Paths are relative to basePath, not prefixed with /api/auth.
      customRules: {
        '/sign-in/email': { window: 60, max: 5 },
        '/sign-up/email': { window: 600, max: 3 },
        '/send-verification-email': { window: 300, max: 3 },
      },
    },
    advanced: {
      database: { generateId: 'uuid' },
      useSecureCookies: true,
      cookiePrefix: 'memoria',
      defaultCookieAttributes: { httpOnly: true, secure: true, sameSite: 'lax', path: '/' },
      // The API overwrites this header using Express's trusted-proxy resolution.
      ipAddress: { ipAddressHeaders: ['x-memoria-client-ip'] },
    },
    plugins: [
      organization({
        creatorRole: 'owner',
        roles: { owner: ownerAc, member: memberAc },
        allowUserToCreateOrganization: async (user) => user.emailVerified,
      }),
    ],
  });
}

export type Auth = ReturnType<typeof createAuth>;
