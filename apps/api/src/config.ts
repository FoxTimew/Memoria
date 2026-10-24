import { z } from 'zod';

const envSchema = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  APP_ORIGIN: z.url().refine((value) => {
    const url = new URL(value);
    return url.protocol === 'https:' && url.origin === value;
  }, 'Expected an HTTPS origin without a trailing slash'),
  BETTER_AUTH_SECRET: z.string().min(32),
  COLLAB_INTERNAL_SECRET: z.string().min(32),
  COLLAB_INTERNAL_URL: z.url().default('http://127.0.0.1:3004/internal/collaboration'),
  DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
  API_HOST: z.string().default('0.0.0.0'),
  API_PORT: z.coerce.number().int().min(1).max(65535).default(3001),
  TRUSTED_PROXY_CIDRS: z.string().default('loopback'),
  SMTP_HOST: z.string().min(1),
  SMTP_PORT: z.coerce.number().int().min(1).max(65535),
  SMTP_SECURE: z.enum(['true', 'false']).transform((value) => value === 'true'),
  SMTP_USER: z.string().default(''),
  SMTP_PASSWORD: z.string().default(''),
  SMTP_FROM: z.string().min(1),
});

export function readConfig(environment: NodeJS.ProcessEnv = process.env) {
  const parsed = envSchema.safeParse(environment);
  if (!parsed.success) {
    // Do not print values: the environment contains credentials.
    throw new Error(
      `Invalid environment fields: ${parsed.error.issues.map((issue) => issue.path.join('.')).join(', ')}`,
    );
  }
  if (Boolean(parsed.data.SMTP_USER) !== Boolean(parsed.data.SMTP_PASSWORD)) {
    throw new Error('SMTP_USER and SMTP_PASSWORD must be configured together');
  }
  if (parsed.data.NODE_ENV === 'production' && !environment.TRUSTED_PROXY_CIDRS) {
    throw new Error('TRUSTED_PROXY_CIDRS must explicitly identify the production proxy');
  }
  return parsed.data;
}
export type Config = ReturnType<typeof readConfig>;
