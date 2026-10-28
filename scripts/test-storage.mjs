import { build, stop } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const { fetch, AbortSignal } = globalThis;

process.loadEnvFile('.env');
const dir = '.local/storage-proof';
const executable = 'packages/storage/dist/conformance.mjs';
await mkdir(dir, { recursive: true });
await build({
  entryPoints: ['packages/storage/src/conformance.ts'],
  outfile: executable,
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  banner: {
    js: "import { createRequire } from 'node:module';const require=createRequire(import.meta.url);",
  },
});
stop();
const image =
  'chrislusf/seaweedfs:4.51@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8';
const name = `memoria-storage-proof-${process.pid}`;
const access = `proof-${randomBytes(8).toString('hex')}`;
const secret = randomBytes(32).toString('hex');
const dockerEnv = { ...process.env, AWS_ACCESS_KEY_ID: access, AWS_SECRET_ACCESS_KEY: secret };
function docker(args) {
  const r = spawnSync('docker', args, {
    env: dockerEnv,
    encoding: 'utf8',
    windowsHide: true,
    timeout: 60000,
  });
  if (r.status !== 0) throw new Error(`Docker fixture operation failed: ${args[0]}`);
  return r.stdout.trim();
}
const providers = [
  {
    name: 'minio-local',
    endpoint: 'http://127.0.0.1:9000',
    access: process.env.MINIO_ROOT_USER || 'memoria-local',
    secret: process.env.MINIO_ROOT_PASSWORD,
  },
  { name: 'seaweedfs-4.51', endpoint: 'http://127.0.0.1:18333', access, secret },
];
let started = false;
let failed = false;
try {
  docker([
    'run',
    '--rm',
    '--detach',
    '--name',
    name,
    '--publish',
    '127.0.0.1:18333:8333',
    '--memory',
    '768m',
    '--cpus',
    '1',
    '--env',
    'AWS_ACCESS_KEY_ID',
    '--env',
    'AWS_SECRET_ACCESS_KEY',
    image,
    'mini',
    '-dir=/data',
  ]);
  started = true;
  await writeFile(
    `${dir}/fixture.json`,
    JSON.stringify(
      { image, loopbackOnly: true, isolatedEphemeralData: true, performanceMeasurement: false },
      null,
      2,
    ),
  );
  let ready = false;
  for (let i = 0; i < 30; i++) {
    try {
      await fetch(providers[1].endpoint, { signal: AbortSignal.timeout(1000) });
      ready = true;
      break;
    } catch {
      await setTimeout(500);
    }
  }
  if (!ready) throw new Error('STORAGE_FIXTURE_UNAVAILABLE');
  for (const provider of providers) {
    if (!provider.secret) throw new Error('LOCAL_STORAGE_CREDENTIALS_REQUIRED');
    const r = spawnSync(process.execPath, [executable], {
      env: {
        ...process.env,
        STORAGE_TEST_PROVIDER: provider.name,
        STORAGE_TEST_ENDPOINT: provider.endpoint,
        STORAGE_TEST_ACCESS: provider.access,
        STORAGE_TEST_SECRET: provider.secret,
        STORAGE_TEST_REPORT: `${dir}/${provider.name}.json`,
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 180000,
      maxBuffer: 2 * 1024 ** 2,
    });
    // The test prints only allowlisted scenario labels; no SDK errors or signed URLs.
    process.stdout.write(r.stdout ?? '');
    await writeFile(`${dir}/${provider.name}.txt`, (r.stdout ?? '') + `\nExit code: ${r.status}\n`);
    failed ||= r.status !== 0;
  }
} finally {
  if (started) docker(['stop', '--time', '5', name]);
}
process.exitCode = failed ? 1 : 0;
