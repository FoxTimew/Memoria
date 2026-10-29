import { guardTestDocker } from './docker-test-isolation.mjs';
import { build, stop } from 'esbuild';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { setTimeout } from 'node:timers/promises';

const directory = resolve('.local/storage-alternatives');
await mkdir(directory, { recursive: true });
const executable = 'packages/storage/dist/conformance.mjs';
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
const providers = [
  {
    name: 'garage-2.5.0',
    image:
      'dxflrs/garage:v2.5.0@sha256:677e5b758e4425a325b811c425c026bf35a4bf42f7ddbaa773de3f4fd779a5a5',
    port: 3900,
  },
  {
    name: 'rustfs-1.0.4',
    image:
      'rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2',
    port: 9000,
  },
];
let failed = false;
const requested = process.argv.includes('--provider')
  ? process.argv[process.argv.indexOf('--provider') + 1]
  : undefined;
if (requested && !providers.some((p) => p.name === requested)) throw new Error('Unknown provider');
for (const p of providers.filter((p) => !requested || requested === p.name)) {
  const name = `memoria-alternative-${p.name.replaceAll('.', '-')}-${process.pid}`;
  const access = 'GK' + randomBytes(16).toString('hex'),
    secret = randomBytes(32).toString('hex');
  const env = {
    ...process.env,
    GARAGE_DEFAULT_ACCESS_KEY: access,
    GARAGE_DEFAULT_SECRET_KEY: secret,
    RUSTFS_ACCESS_KEY: access,
    RUSTFS_SECRET_KEY: secret,
    GARAGE_RPC_SECRET: randomBytes(32).toString('hex'),
  };
  function docker(args) {
    const r = spawnSync('docker', guardTestDocker(args), {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error(`FIXTURE_${p.name}_${args[0]}_FAILED`);
    return r.stdout.trim();
  }
  const args = [
    'run',
    '--rm',
    '--detach',
    '--name',
    name,
    '--publish',
    `127.0.0.1:19000:${p.port}`,
    '--memory',
    '768m',
    '--cpus',
    '1',
  ];
  if (p.name.startsWith('garage')) {
    const config = resolve(directory, 'garage.toml');
    await writeFile(
      config,
      'metadata_dir="/tmp/meta"\ndata_dir="/tmp/data"\ndb_engine="sqlite"\nreplication_factor=1\nrpc_bind_addr="[::]:3901"\nrpc_public_addr="127.0.0.1:3901"\n[s3_api]\ns3_region="us-east-1"\napi_bind_addr="[::]:3900"\n',
    );
    args.push(
      '--mount',
      `type=bind,source=${config},target=/etc/garage.toml,readonly`,
      '--env',
      'GARAGE_RPC_SECRET',
      '--env',
      'GARAGE_DEFAULT_ACCESS_KEY',
      '--env',
      'GARAGE_DEFAULT_SECRET_KEY',
      p.image,
      '/garage',
      'server',
      '--single-node',
      '--default-access-key',
    );
  } else
    args.push(
      '--env',
      'RUSTFS_ACCESS_KEY',
      '--env',
      'RUSTFS_SECRET_KEY',
      '--env',
      'RUSTFS_CONSOLE_ENABLE=false',
      '--env',
      'RUSTFS_OBS_LOGGER_LEVEL=error',
      p.image,
      '/data',
    );
  let started = false;
  try {
    docker(args);
    started = true;
    let ready = false;
    for (let attempt = 0; attempt < 60; attempt++) {
      try {
        await globalThis.fetch('http://127.0.0.1:19000', {
          signal: globalThis.AbortSignal.timeout(1000),
        });
        ready = true;
        break;
      } catch {
        await setTimeout(500);
      }
    }
    if (!ready) throw new Error('FIXTURE_NOT_READY');
    if (p.name.startsWith('garage'))
      docker(['exec', name, '/garage', 'key', 'allow', '--create-bucket', access]);
    await writeFile(
      resolve(directory, `${p.name}-fixture.json`),
      JSON.stringify(
        {
          ...p,
          imageId: docker(['image', 'inspect', p.image, '--format', '{{.Id}}']),
          checkedAt: new Date().toISOString(),
          memoryBytes: 768 * 1024 ** 2,
          cpus: 1,
          loopbackOnly: true,
          performanceMeasurement: false,
          patched: false,
        },
        null,
        2,
      ) + '\n',
    );
    const r = spawnSync(process.execPath, [executable], {
      env: {
        ...process.env,
        STORAGE_TEST_PROVIDER: p.name,
        STORAGE_TEST_ENDPOINT: 'http://127.0.0.1:19000',
        STORAGE_TEST_ACCESS: access,
        STORAGE_TEST_SECRET: secret,
        STORAGE_TEST_REPORT: resolve(directory, `${p.name}.json`),
        STORAGE_TEST_CORS: 'bucket',
      },
      encoding: 'utf8',
      windowsHide: true,
      timeout: 240000,
      maxBuffer: 2 * 1024 ** 2,
    });
    process.stdout.write(r.stdout ?? '');
    await writeFile(
      resolve(directory, `${p.name}.txt`),
      (r.stdout ?? '') + `\nExit code: ${r.status}\n`,
    );
    failed ||= r.status !== 0;
  } finally {
    if (started) docker(['stop', '--time', '5', name]);
  }
}
process.exitCode = failed ? 1 : 0;
