import { createServer } from 'node:http';
import { PgBoss } from 'pg-boss';
import { z } from 'zod';
import { createDatabase } from '@memoria/db';
import { processAuthMail, purgeAuthCounters } from '@memoria/auth';
import nodemailer from 'nodemailer';

const parsed = z
  .object({
    DATABASE_URL: z.string().regex(/^postgres(?:ql)?:\/\//),
    WORKER_HOST: z.string().default('0.0.0.0'),
    WORKER_PORT: z.coerce.number().int().min(1).max(65535).default(3002),
    APP_ORIGIN: z
      .url()
      .refine((value) => new URL(value).protocol === 'https:' && new URL(value).origin === value),
    BETTER_AUTH_SECRET: z.string().min(32),
    SMTP_HOST: z.string().min(1),
    SMTP_PORT: z.coerce.number().int().positive(),
    SMTP_SECURE: z.enum(['true', 'false']),
    SMTP_USER: z.string().default(''),
    SMTP_PASSWORD: z.string().default(''),
    SMTP_FROM: z.string().min(1),
  })
  .safeParse(process.env);
if (!parsed.success) throw new Error('Invalid worker database/host/port configuration');
const config = parsed.data;
if (Boolean(config.SMTP_USER) !== Boolean(config.SMTP_PASSWORD))
  throw new Error('SMTP credentials must be paired');
const connection = createDatabase(config.DATABASE_URL);
const smtp = nodemailer.createTransport({
  host: config.SMTP_HOST,
  port: config.SMTP_PORT,
  secure: config.SMTP_SECURE === 'true',
  requireTLS: process.env.NODE_ENV === 'production' && config.SMTP_SECURE !== 'true',
  ...(config.SMTP_USER ? { auth: { user: config.SMTP_USER, pass: config.SMTP_PASSWORD } } : {}),
  connectionTimeout: 10000,
  socketTimeout: 10000,
});

const boss = new PgBoss({
  connectionString: config.DATABASE_URL,
  schema: 'pgboss',
  application_name: 'memoria-worker',
});
boss.on('error', () => console.error('Worker database operation failed'));
await boss.start();

let stopping = false;
let lastCounterPurge = 0;
let delivering: Promise<void> | undefined;
const poll = setInterval(() => {
  if (stopping || delivering) return;
  delivering = (async () => {
    if (Date.now() - lastCounterPurge >= 60000) {
      await purgeAuthCounters(connection.db);
      lastCounterPurge = Date.now();
    }
    for (let i = 0; i < 20 && !stopping; i++) {
      const done = await processAuthMail(connection.db, {
        origin: config.APP_ORIGIN,
        secret: config.BETTER_AUTH_SECRET,
        send: async (email, subject, text) => {
          await smtp.sendMail({ from: config.SMTP_FROM, to: email, subject, text });
        },
        report: (event) => console.warn(JSON.stringify(event)),
      });
      if (!done) break;
    }
  })()
    .catch(() => console.error('Authentication mail queue unavailable'))
    .finally(() => {
      delivering = undefined;
    });
}, 1000);
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
  clearInterval(poll);
  server.close();
  await delivering;
  smtp.close();
  await connection.pool.end();
  await boss.stop({ graceful: true, timeout: 10000 });
}
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
  process.once(signal, () => {
    void shutdown().catch(() => {
      process.exitCode = 1;
    });
  });
}
