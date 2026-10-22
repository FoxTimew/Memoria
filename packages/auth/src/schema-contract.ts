import type { BetterAuthOptions } from 'better-auth';
import { organization, twoFactor } from 'better-auth/plugins';
import { passkey } from '@better-auth/passkey';
import { apiKey } from '@better-auth/api-key';

/** Schema inspection only. This is deliberately not a running auth configuration. */
export const authSchemaContract = {
  advanced: { database: { generateId: 'uuid' } },
  rateLimit: { storage: 'database' },
  plugins: [
    organization(),
    twoFactor(),
    passkey(),
    apiKey({ references: 'organization', configId: 'public-v1' }),
  ],
} satisfies BetterAuthOptions;
