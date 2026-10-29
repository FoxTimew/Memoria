import { execFileSync, spawnSync } from 'node:child_process';
import { mkdir, readFile, mkdtemp, copyFile, unlink, rmdir } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardTestDocker } from './docker-test-isolation.mjs';

export const imageId = () =>
  execFileSync('docker', ['image', 'inspect', 'memoria-file-validator:7b', '--format', '{{.Id}}'], {
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
export async function decodeFixture(path) {
  const output = await mkdtemp(resolve('.local/image-tests/result-'));
  const input = await mkdtemp(resolve('.local/image-tests/input-'));
  await copyFile(path, resolve(input, 'source'));
  const name = 'memoria-image-decode-' + randomUUID();
  const args = guardTestDocker([
    'run',
    '--rm',
    '--name',
    name,
    '--network',
    'none',
    '--read-only',
    '--memory',
    '512m',
    '--memory-swap',
    '512m',
    '--cpus',
    '1',
    '--pids-limit',
    '64',
    '--cap-drop',
    'ALL',
    '--security-opt',
    'no-new-privileges',
    '--tmpfs',
    '/tmp:rw,noexec,nosuid,size=16m',
    '--mount',
    `type=bind,src=${input},dst=/input,readonly`,
    '--mount',
    `type=bind,src=${output},dst=/output`,
    imageId(),
  ]);
  const began = performance.now();
  try {
    const run = spawnSync('docker', args, { windowsHide: true, timeout: 35000, encoding: 'utf8' });
    if (run.error || run.status !== 0)
      throw Object.assign(new Error('IMAGE_SANDBOX_FAILED'), {
        details: { status: run.status, signal: run.signal, stderr: run.stderr, name, output },
      });
    const result = JSON.parse(await readFile(resolve(output, 'result.json'), 'utf8'));
    return { ...result, wallMs: performance.now() - began, output };
  } finally {
    spawnSync('docker', ['rm', '--force', name], {
      windowsHide: true,
      stdio: 'ignore',
      timeout: 10000,
    });
    // Exact file and empty directory created above; no recursive deletion.
    await unlink(resolve(input, 'source'));
    await rmdir(input);
  }
}
