import { execFileSync, execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { randomUUID } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout as delay } from 'node:timers/promises';
import { get } from 'node:https';

/** Disposable real Caddy/TLS proxy. Never reloads the user's running proxy or trusts a cert globally. */
export async function caddyFixture(backendPort: number) {
  // Inspect/start in a separate process: synchronous Docker inventory must not stall
  // the fixture's in-process collaboration leadership heartbeat.
  const docker = async (args: string[]) =>
    (
      await promisify(execFile)(process.execPath, [resolve('scripts/test-docker.mjs'), ...args], {
        encoding: 'utf8',
        windowsHide: true,
        timeout: 30000,
      })
    ).stdout.trim();
  const current = await docker(['compose', 'ps', '-q', 'caddy']);
  if (!/^[a-f0-9]{12,64}$/.test(current))
    throw new Error('Start the development Caddy container first');
  const image = await docker(['inspect', '--format', '{{.Image}}', current]);
  const id = randomUUID(),
    name = 'memoria-6a-tls-' + id,
    directory = resolve('.local/caddy-6a', id);
  await mkdir(directory, { recursive: true });
  await writeFile(
    resolve(directory, 'Caddyfile'),
    `{\n admin off\n auto_https disable_redirects\n}\nhttps://localhost {\n tls internal\n reverse_proxy host.docker.internal:${backendPort}\n}\n`,
  );
  let created = false;
  const close = () => {
    if (created) {
      execFileSync('docker', ['rm', '--force', name], {
        windowsHide: true,
        timeout: 20000,
        stdio: 'ignore',
      });
      created = false;
    }
  };
  try {
    await docker([
      'run',
      '--pull=never',
      '--rm',
      '-d',
      '--name',
      name,
      '-p',
      '127.0.0.1::443',
      '--add-host',
      'host.docker.internal:host-gateway',
      '--mount',
      `type=bind,src=${resolve(directory, 'Caddyfile')},dst=/etc/caddy/Caddyfile,readonly`,
      image,
    ]);
    created = true;
    const port = Number((await docker(['port', name, '443/tcp'])).match(/127\.0\.0\.1:(\d+)/)?.[1]);
    if (!port) throw new Error('Missing local TLS mapping');
    let ca = '';
    for (let i = 0; i < 50; i++) {
      try {
        ca = await docker(['exec', name, 'cat', '/data/caddy/pki/authorities/local/root.crt']);
        break;
      } catch {
        await delay(100);
      }
    }
    if (!ca.startsWith('-----BEGIN CERTIFICATE-----')) throw new Error('Missing local CA');
    // Certificate and hostname verification remain enabled, also in each WebSocket client.
    await new Promise<void>((resolve, reject) => {
      const request = get(
        { hostname: 'localhost', port, path: '/api/health/collab', ca, timeout: 5000 },
        (r) => {
          r.resume();
          if (r.statusCode === 200) resolve();
          else reject(new Error('TLS proxy health failed'));
        },
      );
      request.on('error', reject);
      request.on('timeout', () => request.destroy(new Error('TLS health timeout')));
    });
    return { url: `wss://localhost:${port}/collab`, ca, image, close };
  } catch (e) {
    close();
    throw e;
  }
}
