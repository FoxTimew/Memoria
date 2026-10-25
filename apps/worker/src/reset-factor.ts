import { parseArgs } from 'node:util';
import { createDatabase } from '@memoria/db';
import { operatorReset } from '@memoria/auth';
const { values } = parseArgs({
  options: {
    'user-id': { type: 'string' },
    factor: { type: 'string' },
    reason: { type: 'string' },
    operator: { type: 'string' },
    apply: { type: 'boolean', default: false },
    confirm: { type: 'string' },
  },
  strict: true,
});
const { DATABASE_URL, APP_ORIGIN, BETTER_AUTH_SECRET } = process.env;
if (!DATABASE_URL || !APP_ORIGIN || !BETTER_AUTH_SECRET || BETTER_AUTH_SECRET.length < 32)
  throw new Error('DATABASE_URL, APP_ORIGIN and BETTER_AUTH_SECRET required');
const db = createDatabase(DATABASE_URL);
try {
  const result = await operatorReset(db.db, {
    userId: values['user-id'] ?? '',
    factor: values.factor ?? '',
    reason: values.reason ?? '',
    operator: values.operator ?? '',
    apply: values.apply,
    ...(values.confirm ? { confirm: values.confirm } : {}),
    origin: APP_ORIGIN,
    secret: BETTER_AUTH_SECRET,
  });
  console.log(
    JSON.stringify(
      {
        mode: values.apply ? 'applied' : 'simulation',
        ...result,
        notice: values.apply
          ? 'Sessions revoked. Re-enrollment email queued; the worker must be running.'
          : 'No changes. Check the account and factor, then use --apply --confirm with this exact user UUID.',
      },
      null,
      2,
    ),
  );
} catch (error) {
  // Do not print database parameters or secret-bearing exception objects.
  console.error(
    'Operator reset refused:',
    error instanceof Error && /^[A-Z_]+$/.test(error.message) ? error.message : 'OPERATION_FAILED',
  );
  process.exitCode = 1;
} finally {
  await db.pool.end();
}
