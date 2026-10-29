import { guardTestDocker } from '../../../../scripts/docker-test-isolation.mjs';
import { spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { S3ObjectStorage } from '@memoria/storage';
export async function storageFixture() {
  const name = 'memoria-files-test-' + randomBytes(6).toString('hex');
  const access = 'test-' + randomBytes(12).toString('hex'),
    secret = randomBytes(32).toString('hex');
  const env = { ...process.env, RUSTFS_ACCESS_KEY: access, RUSTFS_SECRET_KEY: secret };
  const image =
    'rustfs/rustfs:1.0.4@sha256:ed9210d6411d77ffceb70d94b964a3cb7d225983368bc25bebe01e995293dcc2';
  const docker = (args: string[]) => {
    const r = spawnSync('docker', guardTestDocker(args), {
      env,
      encoding: 'utf8',
      windowsHide: true,
      timeout: 60000,
    });
    if (r.status !== 0) throw new Error('STORAGE_FIXTURE_FAILED');
    return r.stdout.trim();
  };
  docker([
    'run',
    '--rm',
    '-d',
    '--name',
    name,
    '--publish',
    '127.0.0.1::9000',
    '--memory',
    '768m',
    '--cpus',
    '1',
    '--env',
    'RUSTFS_ACCESS_KEY',
    '--env',
    'RUSTFS_SECRET_KEY',
    '--env',
    'RUSTFS_CONSOLE_ENABLE=false',
    '--env',
    'RUSTFS_OBS_LOGGER_LEVEL=error',
    image,
    '/data',
  ]);
  try {
    const port = docker(['port', name, '9000/tcp']).split(':').at(-1)!;
    const config = {
      endpoint: 'http://127.0.0.1:' + port,
      publicEndpoint: 'http://127.0.0.1:' + port,
      region: 'us-east-1',
      bucket: 'fixture',
      credentials: { accessKeyId: access, secretAccessKey: secret },
    };
    const storage = new S3ObjectStorage(config);
    let ready = false;
    for (let i = 0; i < 60; i++) {
      try {
        await storage.initialize(process.env.APP_ORIGIN!);
        ready = true;
        break;
      } catch {
        await delay(500);
      }
    }
    if (!ready) throw new Error('STORAGE_FIXTURE_NOT_READY');
    Object.assign(process.env, {
      NODE_ENV: 'test',
      S3_ENDPOINT: config.endpoint,
      S3_PUBLIC_ENDPOINT: config.publicEndpoint,
      S3_BUCKET: config.bucket,
      S3_ACCESS_KEY_ID: access,
      S3_SECRET_ACCESS_KEY: secret,
    });
    return {
      storage,
      config,
      name,
      image,
      close: async () => {
        storage.close();
        docker(['stop', '--time', '3', name]);
      },
    };
  } catch (e) {
    docker(['stop', '--time', '3', name]);
    throw e;
  }
}
