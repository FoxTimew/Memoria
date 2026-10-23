import { createServer } from 'node:http';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';

const parsed = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
    WORKER_HOST: z.string().default('0.0.0.0'),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
  })
  .safeParse(process.env);
if (!parsed.success) throw new Error('Invalid worker database/host/port configuration');
const config = parsed.data;

const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  schema: 'pgboss',
  application_name: 'memoria-worker',
});
boss.on('error', () => console.error('Worker database operation failed'));
await boss.start();

// No business jobs until their modules are implemented. Readiness checks the real database.
let stopping = false;
const server = createServer(async (request, response) => {
  response.setHeader('Content-Type', 'application/json');
  response.setHeader('Cache-Control', 'no-store');
  if (request.method !== 'GET' || request.url !== '/api/health/worker') {
    response.writeHead(404).end(JSON.stringify({ message: 'Not found' }));
    return;
  }
  try {
    if (stopping) throw new Error('Stopping');
    await boss.getDb().executeSql('select 1');
    response.writeHead(200).end(JSON.stringify({ status: 'ok', service: 'worker' }));
  } catch {
    response.writeHead(503).end(JSON.stringify({ status: 'unavailable', service: 'worker' }));
  }
});
server.listen(config.WORKER_PORT, config.WORKER_HOST, () =>
  console.info('Worker ready; pg-boss connected'),
);

async function shutdown() {
  if (stopping) return;
  stopping = true;
  server.close();
  await boss.stop({ graceful: true, timeout: 10000 });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}
