import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { guardTestDocker, inspectDevelopment } from './docker-test-isolation.mjs';
test('actual Docker inventory refuses development volume before container creation', () => {
  const dev = inspectDevelopment(),
    name = 'memoria-isolation-refused-' + randomUUID();
  assert(dev.volumes.length > 0);
  assert.throws(() => {
    const args = guardTestDocker([
      'create',
      '--name',
      name,
      '--mount',
      `type=volume,src=${dev.volumes[0]},dst=/data,readonly`,
      'caddy:2-alpine',
    ]);
    spawnSync('docker', args, { windowsHide: true });
  }, /DOCKER_TEST_ISOLATION: development volume/);
  assert.notEqual(spawnSync('docker', ['inspect', name], { windowsHide: true }).status, 0);
});
