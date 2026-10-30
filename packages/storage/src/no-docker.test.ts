import { it, expect } from 'vitest';
import { build } from 'esbuild';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
it('the application validator dependency graph cannot spawn Docker or open its socket', async () => {
  const result = await build({
    entryPoints: [resolve('packages/storage/src/validate.ts')],
    bundle: true,
    platform: 'node',
    format: 'esm',
    write: false,
    metafile: true,
    logLevel: 'silent',
  });
  const files = Object.keys(result.metafile.inputs).filter((p) => !p.includes('node_modules'));
  expect(files).toContain('packages/storage/src/exchange.ts');
  for (const path of files) {
    const source = await readFile(path, 'utf8');
    expect(source, path).not.toMatch(
      /from\s+['"](?:node:)?child_process['"]|(?:require|import)\s*\(\s*['"](?:node:)?child_process['"]/,
    );
    expect(source, path).not.toMatch(/docker\.sock|docker_engine|DOCKER_HOST/);
  }
});
