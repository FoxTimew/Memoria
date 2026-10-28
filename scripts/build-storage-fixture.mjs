import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { copyFile, mkdir, mkdtemp, readFile, writeFile, stat } from 'node:fs/promises';
import { resolve } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';

const directory = resolve('.local/seaweedfs-qualification');
await mkdir(directory, { recursive: true });
const archive = resolve(directory, 'upstream-4.51.tar.gz');
const sourceSha = '316c9ef7d43bf7a90d6eefa269b2b4ef250992a44320c7c1c1466d3c788f6b08';
const toolchain =
  'golang:1.26.8-bookworm@sha256:dc9ad6c05acc7a88e5b71bde60a5fe3bd4b9f0db209011711b464107438a8107';
const tag = 'memoria-seaweedfs:4.51-memoria1';
async function digest(path) {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
}
if (!(await stat(archive).catch(() => null))) {
  const r = await globalThis.fetch(
    'https://github.com/seaweedfs/seaweedfs/archive/refs/tags/4.51.tar.gz',
  );
  if (!r.ok || !r.body) throw new Error('UPSTREAM_DOWNLOAD_FAILED');
  await pipeline(Readable.fromWeb(r.body), createWriteStream(archive, { flags: 'wx' }));
}
if ((await digest(archive)) !== sourceSha) throw new Error('UPSTREAM_CHECKSUM_MISMATCH');
const generated = resolve(directory, 'dist');
await mkdir(generated, { recursive: true });
const work = await mkdtemp(resolve(generated, 'build-'));
const files = [
  'multipart.patch',
  'memoria_multipart.go',
  'memoria_multipart_test.go',
  'build.sh',
  'Dockerfile',
];
const inputs = {};
for (const name of files) inputs[name] = await digest(resolve('infra/seaweedfs', name));
function docker(args, capture = false) {
  const r = spawnSync('docker', args, {
    stdio: capture ? 'pipe' : 'inherit',
    encoding: 'utf8',
    windowsHide: true,
  });
  if (r.status !== 0) throw new Error(`STORAGE_BUILD_FAILED_${args[0]}`);
  return r.stdout?.trim();
}
docker([
  'run',
  '--rm',
  '--name',
  `memoria-seaweed-build-${process.pid}`,
  '--memory',
  '3g',
  '--cpus',
  '2',
  '--mount',
  `type=bind,source=${archive},target=/upstream.tar.gz,readonly`,
  '--mount',
  `type=bind,source=${resolve('infra/seaweedfs')},target=/patches,readonly`,
  '--mount',
  `type=bind,source=${work},target=/work`,
  '--mount',
  'type=volume,source=memoria-seaweed-go-mod,target=/go/pkg/mod',
  '--mount',
  'type=volume,source=memoria-seaweed-go-build,target=/root/.cache/go-build',
  '--env',
  'GOMAXPROCS=2',
  '--env',
  'GOMEMLIMIT=2GiB',
  '--env',
  'CGO_ENABLED=0',
  '--env',
  'GOTOOLCHAIN=local',
  toolchain,
  'sh',
  '/patches/build.sh',
]);
await copyFile('infra/seaweedfs/Dockerfile', resolve(work, 'Dockerfile'));
await writeFile(resolve(work, '.dockerignore'), '**\n!weed\n!Dockerfile\n');
docker([
  'build',
  '--tag',
  tag,
  '--build-arg',
  `MEMORIA_PATCH_SHA256=${inputs['multipart.patch']}`,
  work,
]);
const image = docker(['image', 'inspect', tag, '--format', '{{.Id}}'], true);
await copyFile(resolve(work, 'go-tests.txt'), resolve(directory, 'go-tests.txt'));
const manifest = {
  sourceCommit: '153ab668c99731a6d29492bf6c61d0b4fa701101',
  sourceSha,
  toolchain,
  inputs,
  image,
  tag,
  binarySha: await digest(resolve(work, 'weed')),
  builtAt: new Date().toISOString(),
  performanceMeasurement: false,
};
await writeFile(resolve(directory, 'manifest.json'), JSON.stringify(manifest, null, 2) + '\n');
const tests = await readFile(resolve(directory, 'go-tests.txt'), 'utf8');
console.log(
  JSON.stringify({
    image,
    binarySha: manifest.binarySha,
    passedTests: (tests.match(/^--- PASS:/gm) ?? []).length,
  }),
);
