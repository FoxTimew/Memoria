import { spawnSync } from 'node:child_process';
import { guardTestDocker } from './docker-test-isolation.mjs';
try {
  const args = guardTestDocker(process.argv.slice(2));
  const r = spawnSync('docker', args, { stdio: 'inherit', windowsHide: true });
  process.exitCode = r.status ?? 1;
} catch (e) {
  console.error(e.message);
  process.exitCode = 1;
}
