import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entries = process.argv.includes('--load')
  ? ['load']
  : process.argv.includes('--size')
    ? ['sizing']
    : ['sizing', 'load'];
for (const entry of [...entries, 'validation-worker']) {
  await build({
    entryPoints: [`apps/collab/src/${entry === 'validation-worker' ? '' : 'proof/'}${entry}.ts`],
    outfile: `apps/collab/dist/${entry}.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    external: ['pg', 'yjs', '@hocuspocus/server', '@hocuspocus/provider', 'ws', 'better-auth'],
    plugins:
      entry === 'validation-worker'
        ? [
            {
              name: 'no-ui',
              setup(b) {
                b.onResolve({ filter: /^(react(?:-dom)?(?:\/|$)|@blocknote\/)/ }, ({ path }) => ({
                  errors: [{ text: `UI forbidden: ${path}` }],
                }));
              },
            },
          ]
        : [],
  });
}
for (const entry of entries) {
  const code = await new Promise((resolve) => {
    const child = spawn(
      process.execPath,
      ['--env-file=.env', `apps/collab/dist/${entry}.mjs`, ...process.argv.slice(2)],
      {
        env: {
          ...process.env,
          COLLAB_PROOF_MIGRATIONS: fileURLToPath(
            new URL('../packages/db/drizzle/', import.meta.url),
          ),
        },
        stdio: 'inherit',
        windowsHide: true,
        timeout: 1200000,
      },
    );
    child.on('error', (error) => {
      console.error(error);
      resolve(1);
    });
    child.on('exit', (code) => resolve(code ?? 1));
  });
  console.log(`Step 2 bis ${entry} exit code: ${code}`);
  if (code !== 0) {
    process.exitCode = code;
    break;
  }
}
