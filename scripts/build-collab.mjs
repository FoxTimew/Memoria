import { build, context } from 'esbuild';
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
const root = fileURLToPath(new URL('../', import.meta.url));
let child;
async function stop() {
  if (child && child.exitCode === null && child.signalCode === null) {
    const ended = once(child, 'exit');
    child.kill('SIGTERM');
    await ended;
  }
}
const watching = process.argv.includes('--watch');
const options = {
  absWorkingDir: root,
  entryPoints: {
    main: 'apps/collab/src/main.ts',
    'incremental-worker': 'apps/collab/src/service/incremental-worker.ts',
  },
  outdir: 'apps/collab/dist',
  outExtension: { '.js': '.mjs' },
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external: [
    'yjs',
    'pg',
    'ws',
    '@hocuspocus/server',
    'better-auth',
    'better-auth/*',
    '@better-auth/passkey',
  ],
  plugins: [
    {
      name: 'no-ui',
      setup(builder) {
        builder.onResolve({ filter: /^(react(?:-dom)?(?:\/|$)|@blocknote\/)/ }, (args) => ({
          errors: [{ text: `UI dependency forbidden: ${args.path}` }],
        }));
      },
    },
    ...(watching
      ? [
          {
            name: 'restart',
            setup(builder) {
              builder.onEnd(async (result) => {
                if (result.errors.length) return;
                await stop();
                child = spawn(process.execPath, [root + 'apps/collab/dist/main.mjs'], {
                  stdio: 'inherit',
                  windowsHide: true,
                });
              });
            },
          },
        ]
      : []),
  ],
};
if (watching) {
  const watcher = await context(options);
  for (const signal of ['SIGTERM', 'SIGINT'])
    process.once(signal, async () => {
      await watcher.dispose();
      await stop();
    });
  await watcher.watch();
} else await build(options);
