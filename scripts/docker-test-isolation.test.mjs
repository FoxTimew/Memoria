import { expect, it } from 'vitest';
import { assertDockerIsolation } from './docker-test-isolation.mjs';
const dev = {
  project: 'memoria',
  volumes: ['memoria_caddy-data'],
  binds: ['C:/repo/infra/caddy/Caddyfile'],
  ports: ['443', '9000'],
};
const test = { project: 'memoria-test-123', mounts: [], ports: ['19443'] };
it('refuses a development volume, including a read-only mount', () => {
  expect(() =>
    assertDockerIsolation(
      { ...test, mounts: [{ type: 'volume', source: 'memoria_caddy-data', readOnly: true }] },
      dev,
    ),
  ).toThrow(/DOCKER_TEST_ISOLATION: development volume/);
});
it('refuses project, host port, bind parent, and host network collisions', () => {
  for (const change of [
    { project: 'memoria' },
    { ports: ['443'] },
    { mounts: [{ type: 'bind', source: 'c:\\REPO' }] },
    { hostNetwork: true },
  ])
    expect(() => assertDockerIsolation({ ...test, ...change }, dev)).toThrow(/Refusing to start/);
});
it('permits distinct project, volumes, paths and ports', () => {
  expect(() =>
    assertDockerIsolation(
      {
        ...test,
        mounts: [
          { type: 'volume', source: 'test-private' },
          { type: 'bind', source: 'C:/repo/.local/test/config' },
        ],
      },
      dev,
    ),
  ).not.toThrow();
});
