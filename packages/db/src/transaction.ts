import type { NodePgDatabase } from 'drizzle-orm/node-postgres';
import type * as schema from './schema/index.ts';

export type Database = NodePgDatabase<typeof schema>;
export type WriteTransaction = Parameters<Parameters<Database['transaction']>[0]>[0];
