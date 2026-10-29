import { createDatabase } from '@memoria/db';
import { S3ObjectStorage } from '@memoria/storage';
import { storageConfig } from '@memoria/storage/config';
import { fileGateway } from './gateway.ts';
const origin = process.env.APP_ORIGIN!,
  secret = process.env.BETTER_AUTH_SECRET!,
  databaseUrl = process.env.DATABASE_URL!;
if (
  !origin ||
  new URL(origin).protocol !== 'https:' ||
  !secret ||
  secret.length < 32 ||
  !databaseUrl
)
  throw Error('Invalid file gateway configuration');
if (process.env.NODE_ENV === 'production' && !process.env.TRUSTED_PROXY_CIDRS)
  throw Error('Configure gateway trusted proxy CIDRs');
const readKey = process.env.S3_READ_ACCESS_KEY_ID,
  readSecret = process.env.S3_READ_SECRET_ACCESS_KEY;
if (Boolean(readKey) !== Boolean(readSecret) || (process.env.NODE_ENV === 'production' && !readKey))
  throw Error('Configure separate read-only storage credentials');
const objectConfig = storageConfig();
if (readKey && readSecret)
  objectConfig.credentials = { accessKeyId: readKey, secretAccessKey: readSecret };
const connection = createDatabase(databaseUrl, { max: 6, timeout: 1500 }),
  storage = new S3ObjectStorage(objectConfig);
const gateway = await fileGateway({
  ...connection,
  storage,
  secret,
  origin,
  trustedProxy: (process.env.TRUSTED_PROXY_CIDRS ?? 'loopback').split(','),
});
const server = gateway.app.listen(
  Number(process.env.FILES_PORT ?? 3005),
  process.env.FILES_HOST ?? '127.0.0.1',
  () => console.info('File gateway ready'),
);
server.headersTimeout = 10000;
server.requestTimeout = 15000;
server.timeout = 30000;
let stopped = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const)
  process.once(signal, () => {
    if (stopped) return;
    stopped = true;
    server.close();
    void gateway.close().finally(async () => {
      storage.close();
      await connection.pool.end();
    });
  });
