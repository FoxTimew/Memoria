import { spawnSync } from 'node:child_process';
// Git does not supply npm_execpath. Invoke the installed package manager from PATH.
// Windows needs its .cmd shim; arguments are fixed, with no filenames/user input interpolated.
const result = spawnSync(
  process.platform === 'win32' ? 'pnpm.cmd' : 'pnpm',
  ['-r', '--if-present', 'typecheck'],
  {
    stdio: 'inherit',
    shell: process.platform === 'win32',
    windowsHide: true,
  },
);
if (result.error) console.error('Cannot start recursive pnpm typecheck:', result.error.message);
process.exitCode = result.error || result.signal ? 1 : (result.status ?? 1);
