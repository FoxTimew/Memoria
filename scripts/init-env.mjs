import { randomBytes } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';

let template = readFileSync(new URL('../.env.example', import.meta.url), 'utf8');
const password = randomBytes(24).toString('hex');
const values = {
  POSTGRES_PASSWORD: password,
  DATABASE_URL: `postgresql://memoria:${password}@127.0.0.1:5432/memoria`,
  BETTER_AUTH_SECRET: randomBytes(32).toString('hex'),
  COLLAB_INTERNAL_SECRET: randomBytes(32).toString('hex'),
  DATA_ENCRYPTION_KEY: randomBytes(32).toString('hex'),
  MINIO_ROOT_PASSWORD: randomBytes(24).toString('hex'),
  S3_ACCESS_KEY_ID: 'memoria-' + randomBytes(12).toString('hex'),
  S3_SECRET_ACCESS_KEY: randomBytes(32).toString('hex'),
};
for (const [key, value] of Object.entries(values))
  template = template.replace(new RegExp(`^${key}=.*$`, 'm'), `${key}=${value}`);
writeFileSync(new URL('../.env', import.meta.url), template, { flag: 'wx', mode: 0o600 });
console.info('Created .env with random local credentials. Existing files are never overwritten.');
