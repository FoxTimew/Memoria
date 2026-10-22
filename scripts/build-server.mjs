import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { build } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = process.argv[2];
if (app !== 'api' && app !== 'worker') throw new Error('Expected api or worker');
const entry = process.argv.includes('--probe') ? 'bootstrap-probe' : 'main';

// tsc preserves Nest's legacy decorators and runtime metadata; esbuild alone does not.
// Bundling then resolves workspace package exports that point directly to .ts sources.
await build({
  absWorkingDir: root,
  entryPoints: [resolve(root, `apps/${app}/src/${entry}.ts`)],
  outfile: resolve(root, `apps/${app}/dist/${entry}.mjs`),
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: [
    '@nestjs/*',
    'reflect-metadata',
    'rxjs',
    'pg',
    'pg-boss',
    'better-auth',
    'better-auth/*',
    'nodemailer',
    'express',
  ],
  banner: {
    js: "import { createRequire as __createRequire } from 'node:module'; const require = __createRequire(import.meta.url);",
  },
  plugins: [
    {
      name: 'typescript-decorator-metadata',
      setup(builder) {
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({
          contents: ts.transpileModule(await readFile(path, 'utf8'), {
            fileName: path,
            compilerOptions: {
              target: ts.ScriptTarget.ES2023,
              module: ts.ModuleKind.ESNext,
              experimentalDecorators: true,
              emitDecoratorMetadata: true,
              isolatedModules: true,
            },
          }).outputText,
          loader: 'js',
        }));
      },
    },
  ],
});
