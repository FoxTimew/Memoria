import { spawnSync } from 'node:child_process';

if (!process.env.DATABASE_URL)
  throw new Error('Run pnpm env:init and start the compose PostgreSQL first.');
const result = spawnSync(
  process.execPath,
  ['node_modules/vitest/vitest.mjs', 'run', 'packages/db/src/schema/schema.integration.test.ts'],
  {
    stdio: 'inherit',
    env: { ...process.env, TEST_DATABASE_URL: process.env.DATABASE_URL },
  },
);
process.exitCode = result.status ?? 1;
