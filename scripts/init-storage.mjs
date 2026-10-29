import { build, stop } from 'esbuild';
import { spawnSync } from 'node:child_process';
await build({
  entryPoints: ['packages/storage/src/initialize.ts'],
  outfile: 'packages/storage/dist/initialize.mjs',
  bundle: true,
  format: 'esm',
  platform: 'node',
  target: 'node24',
  banner: {
    js: "import {createRequire} from 'node:module';const require=createRequire(import.meta.url);",
  },
});
stop();
const result = spawnSync(
  process.execPath,
  ['--env-file=.env', 'packages/storage/dist/initialize.mjs'],
  { stdio: 'inherit', windowsHide: true },
);
process.exitCode = result.status ?? 1;
