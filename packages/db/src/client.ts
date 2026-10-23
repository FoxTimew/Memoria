import pg from 'pg';
import { drizzle } from 'drizzle-orm/node-postgres';
import * as schema from './schema/index.ts';

export function createDatabase(connectionString: string) {
  const pool = new pg.Pool({
    connectionString,
    max: 10,
    connectionTimeoutMillis: 10000,
    query_timeout: 10000,
  });
  pool.on('error', () => console.error('Database idle connection failed'));
  return { db: drizzle(pool, { schema }), pool };
}
