import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { guardTestDocker } from './docker-test-isolation.mjs';
execFileSync(
  'docker',
  guardTestDocker(['build', '--tag', 'memoria-file-validator:7d', 'infra/file-validator']),
  { stdio: 'inherit', windowsHide: true },
);
const image = execFileSync(
  'docker',
  ['image', 'inspect', 'memoria-file-validator:7d', '--format', '{{.Id}}'],
  { encoding: 'utf8', windowsHide: true },
).trim();
if (!/^sha256:[a-f0-9]{64}$/.test(image)) throw Error('Invalid validator digest');
console.log('CONVERTER_IMAGE_ID=' + image);
if (process.argv.includes('--configure-local')) {
  const path = new URL('../.env', import.meta.url);
  let env = readFileSync(path, 'utf8');
  if (/^NODE_ENV=production\s*$/m.test(env)) throw Error('Local configuration refuses production');
  env = env.replace(/^FILES_VALIDATOR_IMAGE=.*(?:\r?\n|$)/m, '');
  if (!/^FILES_VALIDATOR_DIRECTORY=/m.test(env))
    env += 'FILES_VALIDATOR_DIRECTORY=.local/file-exchange\n';
  if (!/^FILES_ORIGIN=/m.test(env)) env += 'FILES_ORIGIN=https://files.localhost\n';
  if (!/^FILES_HOST=/m.test(env)) env += 'FILES_HOST=0.0.0.0\n';
  writeFileSync(path, env, { mode: 0o600 });
  console.log(
    'Local exchange directory configured; image ID displayed above. Restart the worker explicitly.',
  );
}
