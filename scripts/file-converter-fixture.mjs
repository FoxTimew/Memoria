import { execFileSync } from 'node:child_process';
import { mkdtemp, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { randomUUID } from 'node:crypto';
import { guardTestDocker } from './docker-test-isolation.mjs';

export const converterImage = () =>
  execFileSync('docker', ['image', 'inspect', 'memoria-file-validator:7d', '--format', '{{.Id}}'], {
    encoding: 'utf8',
    windowsHide: true,
  }).trim();
export async function converterFixture() {
  await mkdir('.local/converter-tests', { recursive: true });
  const root = await mkdtemp(resolve('.local/converter-tests/run-'));
  const directory = resolve(root, 'exchange'),
    privateDirectory = resolve(root, 'private');
  await mkdir(directory);
  await mkdir(privateDirectory);
  const name = 'memoria-converter-test-' + randomUUID(),
    path = resolve(root, 'compose.json');
  const service = {
    init: true,
    image: converterImage(),
    container_name: name,
    network_mode: 'none',
    read_only: true,
    user: '1000:1000',
    cap_drop: ['ALL'],
    security_opt: ['no-new-privileges:true'],
    mem_limit: '512m',
    memswap_limit: '512m',
    cpus: 1,
    pids_limit: 64,
    restart: 'unless-stopped',
    tmpfs: [
      '/scratch:rw,noexec,nosuid,size=12m,uid=1000,gid=1000,mode=0700',
      '/tmp:rw,noexec,nosuid,size=1m,uid=1000,gid=1000,mode=0700',
    ],
    volumes: [{ type: 'bind', source: directory, target: '/exchange' }],
  };
  await writeFile(path, JSON.stringify({ name, services: { converter: service } }));
  const compose = ['compose', '-p', name, '-f', path];
  const docker = (args) =>
    execFileSync('docker', args, {
      encoding: 'utf8',
      windowsHide: true,
      timeout: 30000,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
  docker(guardTestDocker([...compose, 'up', '-d']));
  return {
    name,
    root,
    config: { directory, privateDirectory, budgetBytes: 6 * 1024 ** 3 },
    compose,
    docker,
    async close() {
      docker([...compose, 'down', '--remove-orphans']);
    },
  };
}
