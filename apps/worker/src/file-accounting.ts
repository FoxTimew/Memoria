import { createDatabase, reconcileFileCapacity } from '@memoria/db';

const args = process.argv.slice(2);
if (args.some((a) => a !== '--repair') || args.length > 1 || !process.env.DATABASE_URL)
  throw new Error('Usage: pnpm files:accounting [--repair]; DATABASE_URL required');
const db = createDatabase(process.env.DATABASE_URL);
try {
  const report = await reconcileFileCapacity(db.pool, args.includes('--repair'));
  console.info(JSON.stringify({ event: 'file_accounting_check', ...report }));
  if (report.driftWorkspaces && !report.repaired) process.exitCode = 1;
} finally {
  await db.pool.end();
}
