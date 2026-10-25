import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { build, context } from 'esbuild';
import ts from 'typescript';

const root = fileURLToPath(new URL('../', import.meta.url));
const app = process.argv[2];
if (app !== 'api' && app !== 'worker') throw new Error('Expected api or worker');
const entry = process.argv.includes('--cache-policy-e2e')
  ? 'cache-policy.e2e'
  : process.argv.includes('--rate-limits-e2e')
    ? 'rate-limits.e2e'
    : process.argv.includes('--recovery-e2e')
      ? 'recovery.e2e'
      : process.argv.includes('--reset-factor')
        ? 'reset-factor'
        : process.argv.includes('--probe')
          ? 'bootstrap-probe'
          : process.argv.includes('--auth-e2e')
            ? 'auth.e2e'
            : process.argv.includes('--strong-auth-e2e')
              ? 'strong-auth.e2e'
              : process.argv.includes('--workspace-security-e2e')
                ? 'workspace-security.e2e'
                : process.argv.includes('--pages-e2e')
                  ? 'pages.e2e'
                  : 'main';
const watching = process.argv.includes('--watch');
const outfile = resolve(root, `apps/${app}/dist/${entry}.mjs`);
let child;

async function stopChild() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const exited = once(child, 'exit');
    child.kill('SIGTERM');
    await exited;
  }
}

// tsc preserves Nest's legacy decorators and runtime metadata; esbuild alone does not.
// Bundling then resolves workspace package exports that point directly to .ts sources.
const options = {
  absWorkingDir: root,
  entryPoints: [resolve(root, `apps/${app}/src/${entry}.ts`)],
  outfile,
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
    '@better-auth/passkey',
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
        builder.onResolve({ filter: /^(react(?:-dom)?(?:\/|$)|@blocknote\/)/ }, (args) => ({
          errors: [{ text: `UI dependency forbidden in server build: ${args.path}` }],
        }));
        builder.onLoad({ filter: /\.ts$/ }, async ({ path }) => ({
          watchFiles: [path],
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
    ...(watching
      ? [
          {
            name: 'restart-server-after-build',
            setup(builder) {
              builder.onEnd(async (result) => {
                if (result.errors.length) return;
                await stopChild();
                child = spawn(process.execPath, [outfile], { stdio: 'inherit', windowsHide: true });
              });
            },
          },
        ]
      : []),
  ],
};

if (watching) {
  const watcher = await context(options);
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.once(signal, async () => {
      await watcher.dispose();
      await stopChild();
      process.exit(0);
    });
  }
  await watcher.watch();
} else {
  if (entry === 'recovery.e2e' || entry === 'pages.e2e' || entry === 'workspace-security.e2e')
    await build({
      entryPoints: [resolve(root, 'apps/collab/src/service/incremental-worker.ts')],
      outfile: resolve(root, 'apps/api/dist/incremental-worker.mjs'),
      bundle: true,
      platform: 'node',
      target: 'node24',
      format: 'esm',
    });
  await build(options);
}
