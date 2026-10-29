import { readFileSync } from 'node:fs';
import { it, expect } from 'vitest';
it('default RustFS digest must have the unchanged 23-scenario conformance proof before adoption', () => {
  const read = (path) => readFileSync(new URL('../' + path, import.meta.url), 'utf8');
  const fixture = JSON.parse(
    read('docs/reviews/evidence/session-7-7a-alternatives/rustfs-1.0.4-fixture.json'),
  );
  const proof = JSON.parse(
    read('docs/reviews/evidence/session-7-7a-alternatives/rustfs-1.0.4.json'),
  );
  const compose = read('compose.yaml');
  expect(compose.match(/image: (rustfs\/rustfs:[^\s]+)/)?.[1]).toBe(fixture.image);
  expect(fixture.patched).toBe(false);
  expect(proof.provider).toBe(fixture.name);
  expect(proof.scenarios).toHaveLength(23);
  expect(proof.scenarios.every((s) => s.passed)).toBe(true);
  expect(compose).toContain('profiles: [conformance]');
});
