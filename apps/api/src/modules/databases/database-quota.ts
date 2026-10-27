import { SetMetadata, HttpException } from '@nestjs/common';
import { consumeBucket, ipKey, throttleKey } from '@memoria/auth';
import type { Database } from '@memoria/db';
export const DATABASE_QUOTA = 'memoria:database-quota';
export type DatabaseFamily = 'L' | 'E' | 'C' | 'S';
export const DatabaseQuota = (family: DatabaseFamily) => SetMetadata(DATABASE_QUOTA, family);
export const databaseBudgets = {
  L: [6000, 120, 0],
  E: [6000, 120, 6000],
  C: [3000, 60, 600],
  S: [300, 30, 120],
} as const;
const check = async (db: Database, key: string, max: number) => {
  const r = await consumeBucket(db, key, max, 60);
  if (!r.allowed)
    throw new HttpException({ code: 'DATABASE_RATE_LIMITED', retryAfter: r.retry }, 429);
};
export const databaseIp = (db: Database, secret: string, f: DatabaseFamily, ip: string) =>
  check(db, ipKey(secret, `database:${f}`, ip), databaseBudgets[f][0]);
export async function databaseAccount(
  db: Database,
  secret: string,
  f: DatabaseFamily,
  user: string,
  workspace: string,
) {
  await check(
    db,
    throttleKey(secret, `database:${f}:account`, f === 'L' ? user : `${user}:${workspace}`),
    databaseBudgets[f][1],
  );
  const max = databaseBudgets[f][2];
  if (max) await check(db, throttleKey(secret, `database:${f}:workspace`, workspace), max);
}

/** One instance-wide gate, acquired before a connection; no second pool or unbounded queue. */
export class DatabaseAdmission {
  private active = 0;
  private readonly queue: { grant: () => void; timer: ReturnType<typeof setTimeout> }[] = [];
  constructor(
    private readonly maximum: number,
    private readonly queued: number,
    private readonly timeout: number,
  ) {}
  private busy() {
    return new HttpException({ code: 'DATABASE_BUSY', retryAfter: 1 }, 429);
  }
  async run<T>(work: () => Promise<T>): Promise<T> {
    if (this.active >= this.maximum) {
      if (this.queue.length >= this.queued) throw this.busy();
      await new Promise<void>((resolve, reject) => {
        const waiting = {
          grant: resolve,
          timer: setTimeout(() => {
            const i = this.queue.indexOf(waiting);
            if (i >= 0) this.queue.splice(i, 1);
            reject(this.busy());
          }, this.timeout),
        };
        this.queue.push(waiting);
      });
    } else this.active++;
    try {
      return await work();
    } finally {
      const next = this.queue.shift();
      if (next) {
        clearTimeout(next.timer);
        next.grant();
      } else this.active--;
    }
  }
}
