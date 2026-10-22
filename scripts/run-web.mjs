import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import { loadEnvFile } from 'node:process';
import { fileURLToPath } from 'node:url';

try {
  loadEnvFile(fileURLToPath(new URL('../.env', import.meta.url)));
} catch (error) {
  if (error.code !== 'ENOENT') throw error;
}

const mode = process.argv[2];
if (!['dev', 'start', 'build'].includes(mode)) throw new Error('Expected dev, start or build');
const require = createRequire(new URL('../apps/web/package.json', import.meta.url));
const cli = require.resolve('next/dist/bin/next');
process.env.NODE_ENV = mode === 'dev' ? 'development' : 'production';
process.env.NEXT_TELEMETRY_DISABLED = '1';
process.argv = [
  process.execPath,
  cli,
  mode,
  ...(mode === 'build' ? [] : ['--hostname', '0.0.0.0']),
];
await import(pathToFileURL(cli).href);
