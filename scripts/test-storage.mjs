import { guardTestDocker } from './docker-test-isolation.mjs';
import { build, stop } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { createHash, randomBytes } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { setTimeout } from 'node:timers/promises';

const { fetch, AbortSignal } = globalThis;

process.loadEnvFile('.env');
const candidate = process.argv.includes('--candidate');
const dir = candidate ? '.local/storage-proof-candidate' : '.local/storage-proof';
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
let image =
  'chrislusf/seaweedfs:4.51@sha256:f7a49e3f3972ebed5be2ed4befa4a0c68eb7bdddba6e692d42729ceb545134b8';
if (candidate) {
  const manifest = JSON.parse(
    await readFile('.local/seaweedfs-qualification/manifest.json', 'utf8'),
  );
  if (typeof manifest.image !== 'string' || !/^sha256:[a-f0-9]{64}$/.test(manifest.image))
    throw new Error('BUILD_STORAGE_FIXTURE_FIRST');
  for (const name of [
    'multipart.patch',
    'memoria_multipart.go',
    'memoria_multipart_test.go',
    'build.sh',
    'Dockerfile',
  ]) {
    const hash = createHash('sha256')
      .update(await readFile(`infra/seaweedfs/${name}`))
      .digest('hex');
    if (manifest.inputs?.[name] !== hash) throw new Error('STALE_STORAGE_FIXTURE_REBUILD_REQUIRED');
  }
  image = manifest.image;
}
const name = `memoria-storage-proof-${process.pid}`;
const access = `proof-${randomBytes(8).toString('hex')}`;
const secret = randomBytes(32).toString('hex');
const dockerEnv = {
  ...process.env,
  AWS_ACCESS_KEY_ID: access,
  AWS_SECRET_ACCESS_KEY: secret,
  MINIO_ROOT_USER: access,
  MINIO_ROOT_PASSWORD: secret,
  MINIO_API_CORS_ALLOW_ORIGIN: 'https://localhost',
};
function docker(args) {
  const r = spawnSync('docker', guardTestDocker(args), {
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
    name: 'minio-global-cors',
    endpoint: 'http://127.0.0.1:19000',
    access,
    secret,
    cors: 'global',
  },
  {
    name: candidate ? 'seaweedfs-4.51-memoria1' : 'seaweedfs-4.51',
    endpoint: 'http://127.0.0.1:18333',
    access,
    secret,
  },
];
const started = [];
let failed = false;
try {
  let minioImage;
  {
    const config = JSON.parse(
      docker([
        'compose',
        '--profile',
        'conformance',
        'config',
        '--format',
        'json',
        '--no-interpolate',
      ]),
    );
    const localImage = config.services.minio.image ?? `${config.name}-minio:latest`;
    minioImage = docker(['image', 'inspect', localImage, '--format', '{{.Id}}']);
    const minioName = `${name}-minio`;
    docker([
      'run',
      '--rm',
      '--detach',
      '--name',
      minioName,
      '--publish',
      '127.0.0.1:19000:9000',
      '--memory',
      '768m',
      '--cpus',
      '1',
      '--env',
      'MINIO_ROOT_USER',
      '--env',
      'MINIO_ROOT_PASSWORD',
      '--env',
      'MINIO_API_CORS_ALLOW_ORIGIN',
      minioImage,
      'server',
      '/data',
    ]);
    started.push(minioName);
  }
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
  started.push(name);
  await writeFile(
    `${dir}/fixture.json`,
    JSON.stringify(
      {
        image,
        ...(minioImage ? { minioImage, minioCors: 'global exact origin' } : {}),
        loopbackOnly: true,
        isolatedEphemeralData: true,
        performanceMeasurement: false,
      },
      null,
      2,
    ),
  );
  for (const provider of providers) {
    let ready = false;
    for (let i = 0; i < 30; i++) {
      try {
        await fetch(provider.endpoint, { signal: AbortSignal.timeout(1000) });
        ready = true;
        break;
      } catch {
        await setTimeout(500);
      }
    }
    if (!ready) throw new Error('STORAGE_FIXTURE_UNAVAILABLE');
  }
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
        STORAGE_TEST_CORS: provider.cors ?? 'bucket',
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
  for (const owned of started.reverse()) docker(['stop', '--time', '5', owned]);
}
process.exitCode = failed ? 1 : 0;
