import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';

export function createDatabase(
  connectionString: string,
  options: { pipeline?: boolean; max?: number; timeout?: number } = {},
) {
  const pool = new pg.Pool({
    connectionString,
    max: options.max ?? 10,
    connectionTimeoutMillis: options.timeout ?? 10000,
    query_timeout: options.timeout ?? 10000,
    pipeline: options.pipeline ?? false,
  });
  pool.on('error', () => console.error('Database idle connection failed'));
  return { db: drizzle(pool, { schema }), pool };
}
