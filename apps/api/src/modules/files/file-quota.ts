import { SetMetadata, HttpException } from '@nestjs/common';
import { consumeBucket, ipKey, throttleKey } from '@memoria/auth';
import type { Database } from '@memoria/db';
export const FILE_QUOTA = 'memoria:file-quota';
export type FileFamily = 'U' | 'P' | 'L' | 'M';
export const FileQuota = (family: FileFamily) => SetMetadata(FILE_QUOTA, family);
export const fileBudgets = {
  U: [1500, 30],
  P: [6000, 120],
  L: [6000, 120],
  M: [1500, 30],
} as const;
async function check(db: Database, key: string, max: number) {
  const r = await consumeBucket(db, key, max, 60);
  if (!r.allowed) throw new HttpException({ code: 'FILE_RATE_LIMITED', retryAfter: r.retry }, 429);
}
export const fileIp = (db: Database, secret: string, f: FileFamily, ip: string) =>
  check(db, ipKey(secret, 'files:' + f, ip), fileBudgets[f][0]);
export const fileAccount = (db: Database, secret: string, f: FileFamily, user: string) =>
  check(db, throttleKey(secret, 'files:' + f + ':account', user), fileBudgets[f][1]);
