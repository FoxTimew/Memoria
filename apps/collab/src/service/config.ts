import { z } from 'zod';
const positive = (fallback: number) => z.coerce.number().int().positive().default(fallback);
const schema = z.object({
  APP_ORIGIN: z.url().refine((s) => new URL(s).protocol === 'https:' && new URL(s).origin === s),
  DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
  BETTER_AUTH_SECRET: z.string().min(32),
  COLLAB_HOST: z.string().default('127.0.0.1'),
  COLLAB_PORT: z.coerce.number().int().min(0).max(65535).default(3003),
  COLLAB_INTERNAL_HOST: z.string().default('127.0.0.1'),
  COLLAB_INTERNAL_PORT: z.coerce.number().int().min(0).max(65535).default(3004),
  COLLAB_INTERNAL_SECRET: z.string().min(32),
  COLLAB_REPLICA_MEMORY_BYTES: positive(1024 ** 3).refine(
    (n) => n >= 160 * 1024 ** 2,
    'At least one replica reservation',
  ),
  COLLAB_REPLICA_IDLE_MS: positive(300000),
  COLLAB_MAX_SOCKETS: positive(500),
  COLLAB_MAX_USER_SOCKETS: positive(20),
  COLLAB_MAX_UNAUTHENTICATED: positive(100),
  COLLAB_ROOM_QUEUE_BYTES: positive(8 * 1024 ** 2),
  COLLAB_ROOM_QUEUE_MESSAGES: positive(100),
  COLLAB_TOTAL_QUEUE_BYTES: positive(64 * 1024 ** 2),
  COLLAB_UPDATES_PER_SECOND: positive(30),
  COLLAB_UPDATE_BURST: positive(60),
});
export function readCollabConfig(env: NodeJS.ProcessEnv = process.env) {
  const result = schema.safeParse(env);
  if (!result.success)
    throw new Error(
      `Invalid collaboration configuration: ${result.error.issues.map((i) => i.path.join('.')).join(', ')}`,
    );
  return result.data;
}
export type CollabConfig = ReturnType<typeof readCollabConfig>;
export const documentBytes = 1024 ** 2;
