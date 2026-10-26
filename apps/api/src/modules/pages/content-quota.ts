import { SetMetadata, HttpException } from '@nestjs/common';
import { consumeBucket, ipKey, throttleKey } from '@memoria/auth';
import type { Database } from '@memoria/db';
export const CONTENT_QUOTA = 'memoria:content-quota';
export const ContentQuota = () => SetMetadata(CONTENT_QUOTA, true);
export function contentQuotaRead(method: string, route: string) {
  return (
    ['GET', 'HEAD'].includes(method) ||
    route.endsWith('/collaboration') ||
    route.endsWith('/preview')
  );
}
export async function admitContentIp(
  db: Database,
  secret: string,
  route: string,
  method: string,
  ip: string,
) {
  const reading = contentQuotaRead(method, route);
  // Express's matched template, not the untrusted URL/UUID/query string.
  const result = await consumeBucket(
    db,
    ipKey(secret, `content:${reading ? 'read' : 'write'}:${route}`, ip),
    reading ? 3600 : 600,
    60,
  );
  if (!result.allowed)
    throw new HttpException({ code: 'CONTENT_RATE_LIMITED', retryAfter: result.retry }, 429);
}
export async function admitContentAccount(
  db: Database,
  secret: string,
  user: string,
  workspace: string,
  read: boolean,
) {
  const key = throttleKey(
    secret,
    `content:${read ? 'read' : 'write'}`,
    read ? user : `${user}:${workspace}`,
  );
  const result = await consumeBucket(db, key, 120, 60);
  if (!result.allowed)
    throw new HttpException({ code: 'CONTENT_RATE_LIMITED', retryAfter: result.retry }, 429);
}
