import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const options = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  external: ['pg', 'yjs', '@hocuspocus/server', '@hocuspocus/provider', 'ws', 'better-auth'],
  sourcemap: true,
};
// Only this input generator may load BlockNote. Worker/journal remain UI-free.
await build({
  ...options,
  entryPoints: ['apps/collab/src/proof/performance.ts'],
  outfile: 'apps/collab/dist/performance.mjs',
});
await build({
  ...options,
  entryPoints: ['apps/collab/src/proof/transport.ts'],
  outfile: 'apps/collab/dist/transport.mjs',
});
await build({
  ...options,
  entryPoints: ['apps/collab/src/validation-worker.ts'],
  outfile: 'apps/collab/dist/validation-worker.mjs',
  plugins: [
    {
      name: 'no-ui',
      setup(builder) {
        builder.onResolve({ filter: /^(react(?:-dom)?(?:\/|$)|@blocknote\/)/ }, ({ path }) => ({
          errors: [{ text: `UI forbidden in validation worker: ${path}` }],
        }));
      },
    },
  ],
});
for (const entry of process.argv.includes('--transport')
  ? ['transport']
  : ['performance', 'transport']) {
  const code = await new Promise((resolve) => {
    const child = spawn(process.execPath, ['--env-file=.env', `apps/collab/dist/${entry}.mjs`], {
      cwd: root,
      env: {
        ...process.env,
        COLLAB_PROOF_MIGRATIONS: fileURLToPath(new URL('../packages/db/drizzle/', import.meta.url)),
      },
      stdio: 'inherit',
      windowsHide: true,
      timeout: 60000,
    });
    child.on('error', (error) => {
      console.error(error.message);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  console.log(`Collaboration ${entry} proof exit code: ${code}`);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
