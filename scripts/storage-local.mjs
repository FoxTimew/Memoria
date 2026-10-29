import { readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
// Local opt-in migration only. Never rotates authentication keys or deletes MinIO data.
let content = readFileSync('.env', 'utf8');
const get = (k) => content.match(new RegExp('^' + k + '=(.*)$', 'm'))?.[1].trim();
if (!['http://127.0.0.1:9000', 'http://localhost:9000'].includes(get('S3_ENDPOINT')))
  throw new Error('Local storage migration requires the existing loopback endpoint');
const set = (k, v) => {
  if (new RegExp('^' + k + '=', 'm').test(content))
    content = content.replace(new RegExp('^' + k + '=.*$', 'm'), k + '=' + v);
  else content += '\n' + k + '=' + v + '\n';
};
if (!get('S3_ACCESS_KEY_ID')) set('S3_ACCESS_KEY_ID', 'memoria-' + randomBytes(12).toString('hex'));
if (!get('S3_SECRET_ACCESS_KEY')) set('S3_SECRET_ACCESS_KEY', randomBytes(32).toString('hex'));
set('S3_PUBLIC_ENDPOINT', 'https://uploads.localhost:9443');
writeFileSync('.env', content, { mode: 0o600 });
console.log('Local S3 settings updated; credentials withheld; MinIO volume retained.');
