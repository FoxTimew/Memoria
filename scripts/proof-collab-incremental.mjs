import { build } from 'esbuild';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
const entry = process.argv.includes('--memory')
  ? 'incremental-memory'
  : process.argv.includes('--transport')
    ? 'transport'
    : process.argv.includes('--abuse')
      ? 'abuse'
      : 'incremental-performance';
for (const name of [entry, 'incremental-worker', 'validation-worker'])
  await build({
    entryPoints: [`apps/collab/src/${name === 'validation-worker' ? '' : 'proof/'}${name}.ts`],
    outfile: `apps/collab/dist/${name}.mjs`,
    bundle: true,
    platform: 'node',
    target: 'node24',
    format: 'esm',
    sourcemap: true,
    external: ['pg', 'yjs', '@hocuspocus/server', '@hocuspocus/provider', 'ws', 'better-auth'],
    plugins: name.includes('worker')
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
const code = await new Promise((resolve) => {
  const child = spawn(
    process.execPath,
    [
      '--expose-gc',
      '--max-old-space-size=6144',
      '--env-file=.env',
      `apps/collab/dist/${entry}.mjs`,
      ...process.argv.slice(2),
    ],
    {
      env: {
        ...process.env,
        COLLAB_PROOF_MIGRATIONS: fileURLToPath(new URL('../packages/db/drizzle/', import.meta.url)),
      },
      stdio: 'inherit',
      windowsHide: true,
      timeout: 1200000,
    },
  );
  child.on('error', (e) => {
    console.error(e);
    resolve(1);
  });
  child.on('exit', (c) => resolve(c ?? 1));
});
console.log(`Incremental ${entry} exit code: ${code}`);
process.exitCode = code;
