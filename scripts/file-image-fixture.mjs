import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import { build, stop } from 'esbuild';
import { pathToFileURL } from 'node:url';
import { converterFixture } from './file-converter-fixture.mjs';
import { execFileSync } from 'node:child_process';
import { mkdir, mkdtemp, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardTestDocker } from './docker-test-isolation.mjs';

export const imageId = () =>
  execFileSync('docker', ['image', 'inspect', 'memoria-file-validator:7d', '--format', '{{.Id}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
export async function imageFixture(large = false) {
  await mkdir('.local/image-tests', { recursive: true });
  const path = await mkdtemp(resolve('.local/image-tests/fixture-'));
  const args = guardTestDocker([
    'run',
    '--rm',
    '--name',
    'memoria-image-fixture-' + randomUUID(),
    '--network',
    'none',
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--mount',
    `type=bind,src=${path},dst=/output`,
    '--entrypoint',
    'node',
    imageId(),
    '/validator/fixture.mjs',
    large ? 'large' : 'small',
  ]);
  execFileSync('docker', args, {
    windowsHide: true,
    timeout: 120000,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  return path;
}

let converter, exchange;
export async function startImageConverter() {
  if (converter) return converter;
  const outfile = resolve('.local/converter/dist/exchange.mjs');
  await build({
    entryPoints: ['packages/storage/src/exchange.ts'],
    outfile,
    bundle: true,
    platform: 'node',
    format: 'esm',
    target: 'node24',
    banner: {
      js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
    },
  });
  exchange = await import(pathToFileURL(outfile).href);
  stop();
  converter = await converterFixture();
  return converter;
}
export async function closeImageConverter() {
  if (converter) {
    await converter.close();
    converter = undefined;
  }
}
export async function decodeFixture(path) {
  await startImageConverter();
  const bytes = (await stat(path)).size;
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  const job = await exchange.createExchangeJob(converter.config, bytes);
  const began = performance.now();
  try {
    await exchange.writeSource(job, createReadStream(path), bytes, hash.digest('base64'), () => {});
    const { result, privatePath } = await exchange.convertExchange(
      job,
      converter.config,
      bytes,
      () => {},
    );
    return { ...result, wallMs: performance.now() - began, output: privatePath };
  } finally {
    await exchange.removeJob(job.path);
  }
}
