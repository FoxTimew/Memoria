import { SetMetadata, HttpException } from '@nestjs/common';
import { consumeBucket, ipKey, throttleKey } from '@memoria/auth';
import type { Database } from '@memoria/db';
export type AccessFamily = 'read' | 'send' | 'respond' | 'mutate';
export const ACCESS_QUOTA = 'memoria:access-quota';
export const AccessQuota = (family: AccessFamily) => SetMetadata(ACCESS_QUOTA, family);
const limits = {
  read: [600, 60, 120],
  send: [100, 600, 50],
  respond: [150, 300, 30],
  mutate: [60, 60, 30],
} as const;
export async function accessIp(
  db: Database,
  secret: string,
  family: AccessFamily,
  route: string,
  ip: string,
) {
  const [max, seconds] = limits[family];
  const result = await consumeBucket(
    db,
    ipKey(secret, `access:${family}:${route}`, ip),
    max,
    seconds,
  );
  if (!result.allowed)
    throw new HttpException({ code: 'ACCESS_RATE_LIMITED', retryAfter: result.retry }, 429);
}
export async function accessAccount(
  db: Database,
  secret: string,
  family: AccessFamily,
  user: string,
  workspace: string,
) {
  const [, seconds, max] = limits[family];
  const key = throttleKey(
    secret,
    `access:${family}`,
    ['send', 'mutate'].includes(family) ? `${user}:${workspace.toLowerCase()}` : user,
  );
  const result = await consumeBucket(db, key, max, seconds);
  if (!result.allowed)
    throw new HttpException({ code: 'ACCESS_RATE_LIMITED', retryAfter: result.retry }, 429);
}
