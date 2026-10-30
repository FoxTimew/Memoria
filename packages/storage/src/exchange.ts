import { constants, createWriteStream } from 'node:fs';
import {
  open,
  lstat,
  readdir,
  mkdir,
  rename,
  writeFile,
  unlink,
  rmdir,
  statfs,
} from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { randomUUID, randomBytes, createHash } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { pipeline } from 'node:stream/promises';
import { Transform } from 'node:stream';
import { webpDimensions } from './derivative.ts';

export type ValidatorConfig = { directory: string; privateDirectory: string; budgetBytes: number };
export function validatorConfig(env: NodeJS.ProcessEnv = process.env): ValidatorConfig {
  const directory = resolve(env.FILES_VALIDATOR_DIRECTORY ?? '.local/file-exchange');
  const privateDirectory = resolve(
    env.FILES_VALIDATOR_PRIVATE_DIRECTORY ?? '.local/file-validation-private',
  );
  const budgetBytes = Number(env.FILES_VALIDATOR_EXCHANGE_BYTES ?? 6 * 1024 ** 3);
  if (!Number.isSafeInteger(budgetBytes) || budgetBytes < 16 * 1024 ** 2 || budgetBytes > 1024 ** 4)
    throw Error('INVALID_EXCHANGE_BUDGET');
  const a = directory.toLowerCase(),
    b = privateDirectory.toLowerCase();
  if (a === b || a.startsWith(b + sep) || b.startsWith(a + sep))
    throw Error('PRIVATE_SNAPSHOT_MUST_BE_OUTSIDE_EXCHANGE');
  return { directory, privateDirectory, budgetBytes };
}
export const jobPattern = /^job-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const files = [
  'owner.json',
  'owner.json.tmp',
  'request.json',
  'request.json.tmp',
  'running.json',
  'result.json',
  'result.json.tmp',
  'cancel.json',
];
export async function atomicFile(path: string, value: string) {
  const h = await open(path + '.tmp', 'wx', 0o600);
  try {
    await h.writeFile(value);
    await h.sync();
  } finally {
    await h.close();
  }
  // A short Windows/WSL reader can deny delete-sharing while polling the marker.
  // Retry only the atomic rename: never remove the destination or republish bytes.
  const deadline = Date.now() + 250;
  for (let attempt = 0; ; attempt++) {
    try {
      await rename(path + '.tmp', path);
      return;
    } catch (error) {
      const code = (error as NodeJS.ErrnoException).code;
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(code ?? '') ||
        attempt >= 5 ||
        Date.now() >= deadline
      )
        throw error;
      await delay(Math.min(5 * 2 ** attempt, Math.max(0, deadline - Date.now())));
    }
  }
}
export async function readBounded(path: string, max: number) {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > max)
    throw Error('INVALID_EXCHANGE_FILE');
  const h = await open(
    path,
    constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NOFOLLOW),
  );
  try {
    const actual = await h.stat();
    if (actual.ino !== st.ino || actual.dev !== st.dev || actual.size !== st.size)
      throw Error('INVALID_EXCHANGE_FILE');
    const data = Buffer.alloc(st.size + 1);
    let n = 0;
    while (n < data.length) {
      const r = await h.read(data, n, data.length - n, n);
      if (!r.bytesRead) break;
      n += r.bytesRead;
    }
    if (n !== st.size) throw Error('INVALID_EXCHANGE_FILE');
    return data.subarray(0, n);
  } finally {
    await h.close();
  }
}
export async function removeJob(path: string) {
  // No recursive deletion, caller-supplied filename, junction or unknown content.
  if ((await readdir(path)).some((n) => ![...files, 'input', 'output'].includes(n))) return false;
  for (const [part, names] of [
    ['input', ['source', 'source.tmp']],
    ['output', ['display.webp', 'thumbnail.webp', 'display.webp.tmp', 'thumbnail.webp.tmp']],
  ] as const) {
    const folder = resolve(path, part),
      st = await lstat(folder).catch(() => null);
    if (!st) continue;
    if (!st.isDirectory() || st.isSymbolicLink()) return false;
    for (const n of await readdir(folder)) {
      const f = await lstat(resolve(folder, n));
      if (
        !(names as readonly string[]).includes(n) ||
        !f.isFile() ||
        f.isSymbolicLink() ||
        f.nlink !== 1
      )
        return false;
    }
  }
  for (const part of ['input', 'output']) {
    const folder = resolve(path, part);
    for (const n of await readdir(folder).catch(() => [])) await unlink(resolve(folder, n));
    await rmdir(folder).catch(() => {});
  }
  for (const n of files) await unlink(resolve(path, n)).catch(() => {});
  await rmdir(path);
  return true;
}
export async function cleanupExchange(root: string, now = Date.now()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  let count = 0;
  for (const name of await readdir(root)) {
    if (!jobPattern.test(name)) continue;
    const path = resolve(root, name),
      st = await lstat(path);
    if (!st.isDirectory() || st.isSymbolicLink()) continue;
    try {
      const owner = JSON.parse((await readBounded(resolve(path, 'owner.json'), 1024)).toString());
      if (
        owner.protocol === 2 &&
        owner.job === name &&
        Number.isSafeInteger(owner.expiresAt) &&
        owner.expiresAt < now
      )
        if (await removeJob(path)) count++;
    } catch {
      // Crash between mkdir and atomic owner publication: only an empty/temporary
      // marker directory is reclaimable, never unknown payloads.
      const names = await readdir(path).catch(() => ['unknown']);
      if (st.mtimeMs < now - 600000 && names.every((n) => n === 'owner.json.tmp'))
        if (await removeJob(path)) count++;
    }
  }
  return count;
}
export async function cleanupPrivate(root: string, now = Date.now()) {
  await mkdir(root, { recursive: true, mode: 0o700 });
  const st = await lstat(root);
  if (!st.isDirectory() || st.isSymbolicLink()) throw Error('INVALID_PRIVATE_DIRECTORY');
  for (const name of await readdir(root)) {
    if (!jobPattern.test(name)) continue;
    const path = resolve(root, name),
      info = await lstat(path);
    if (!info.isDirectory() || info.isSymbolicLink()) continue;
    try {
      const marker = JSON.parse((await readBounded(resolve(path, 'owner.json'), 1024)).toString());
      if (marker.protocol !== 2 || marker.job !== name || marker.expiresAt >= now) continue;
      if (
        (await readdir(path)).some(
          (n) => !['owner.json', 'display.webp', 'thumbnail.webp'].includes(n),
        )
      )
        continue;
      await removePrivate(path);
    } catch {
      /* Preserve unrecognized private data. */
    }
  }
}
async function usage(path: string, depth = 0): Promise<number> {
  if (depth > 4) throw Error('INVALID_EXCHANGE_CONTENT');
  let bytes = 0,
    count = 0;
  for (const n of await readdir(path)) {
    if (++count > 1000) throw Error('INVALID_EXCHANGE_CONTENT');
    const p = resolve(path, n),
      st = await lstat(p);
    if (st.isSymbolicLink() || (!st.isDirectory() && (!st.isFile() || st.nlink !== 1)))
      throw Error('INVALID_EXCHANGE_CONTENT');
    bytes += st.isDirectory() ? await usage(p, depth + 1) : st.size;
  }
  return bytes;
}
export async function createExchangeJob(config: ValidatorConfig, bytes: number) {
  await cleanupExchange(config.directory);
  await cleanupPrivate(config.privateDirectory);
  const st = await lstat(config.directory);
  if (st.isSymbolicLink() || !st.isDirectory()) throw Error('INVALID_EXCHANGE_DIRECTORY');
  const disk = await statfs(config.directory);
  if (
    (await usage(config.directory)) +
      (await usage(config.privateDirectory)) +
      bytes +
      24 * 1024 ** 2 >
      config.budgetBytes ||
    disk.bavail * disk.bsize < bytes + 128 * 1024 ** 2
  )
    throw Error('FILE_SCRATCH_CAPACITY');
  // The PostgreSQL instance lock serializes admission. Do not overlap an interrupted decoder.
  if ((await readdir(config.directory)).length) throw Error('FILE_EXCHANGE_BUSY');
  const name = 'job-' + randomUUID(),
    path = resolve(config.directory, name);
  await mkdir(path, { mode: 0o700 });
  await atomicFile(
    resolve(path, 'owner.json'),
    JSON.stringify({ protocol: 2, job: name, expiresAt: Date.now() + 600000 }),
  );
  await mkdir(resolve(path, 'input'), { mode: 0o700 });
  await mkdir(resolve(path, 'output'), { mode: 0o700 });
  return {
    name,
    path,
    input: resolve(path, 'input/source'),
    output: resolve(path, 'output'),
    nonce: randomBytes(32).toString('hex'),
  };
}
export type ExchangeJob = Awaited<ReturnType<typeof createExchangeJob>>;
type Variant = {
  variant: 'display' | 'thumbnail';
  bytes: number;
  width: number;
  height: number;
  sha256: string;
};
export type ValidationResult = {
  status: 'validated' | 'rejected';
  mime?: string;
  preview?: string;
  width?: number;
  height?: number;
  variants: Variant[];
};
export async function convertExchange(
  job: ExchangeJob,
  config: ValidatorConfig,
  bytes: number,
  assertLease: () => void,
) {
  const expiresAt = Date.now() + 60000;
  await atomicFile(
    resolve(job.path, 'owner.json'),
    JSON.stringify({ protocol: 2, job: job.name, expiresAt }),
  );
  await atomicFile(
    resolve(job.path, 'request.json'),
    JSON.stringify({ protocol: 2, job: job.name, nonce: job.nonce, bytes, expiresAt }),
  );
  const started = Date.now();
  let envelope;
  while (Date.now() - started < 35000) {
    assertLease();
    if (await lstat(resolve(job.path, 'result.json')).catch(() => null)) {
      envelope = JSON.parse(
        (await readBounded(resolve(job.path, 'result.json'), 16384)).toString(),
      );
      break;
    }
    await delay(250);
  }
  if (
    !envelope ||
    envelope.protocol !== 2 ||
    envelope.job !== job.name ||
    envelope.nonce !== job.nonce ||
    envelope.expiresAt !== expiresAt ||
    Date.now() > expiresAt
  )
    throw Error('INVALID_OR_EXPIRED_CONVERTER_RESULT');
  const r = envelope.result as ValidationResult;
  if (r?.status === 'rejected')
    return {
      result: { status: 'rejected', variants: [] } as ValidationResult,
      privatePath: undefined,
    };
  if (
    r?.status !== 'validated' ||
    !Array.isArray(r.variants) ||
    !['available', 'unsupported', 'multiple-frames', 'dimensions'].includes(r.preview ?? '')
  )
    throw Error('INVALID_VALIDATOR_RESULT');
  // Worker independently detects the immutable input. Returned MIME alone grants no inline right.
  const source = await open(job.input, 'r'),
    head = Buffer.alloc(8192);
  let length;
  try {
    length = (await source.read(head)).bytesRead;
  } finally {
    await source.close();
  }
  const text = head
    .subarray(0, length)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  // Only the three raster signatures can authorize a preview. Never run a general
  // archive/media parser in the privileged worker, even for a second opinion.
  let mime: string | undefined = head.subarray(0, 3).equals(Buffer.from([255, 216, 255]))
    ? 'image/jpeg'
    : head.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]))
      ? 'image/png'
      : head.toString('ascii', 0, 4) === 'RIFF' && head.toString('ascii', 8, 12) === 'WEBP'
        ? 'image/webp'
        : undefined;
  if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/i.test(text)) mime = 'image/svg+xml';
  else if (/^(?:<!doctype\s+html|<html\b|<script\b)/i.test(text)) mime = 'text/html';
  if (
    typeof r.mime !== 'string' ||
    !/^[-a-z0-9.+]+\/[-a-z0-9.+]+$/.test(r.mime) ||
    (mime && r.mime !== mime)
  )
    throw Error('CONVERTER_TYPE_MISMATCH');
  if (r.preview === 'available') {
    if (
      !['image/jpeg', 'image/png', 'image/webp'].includes(mime ?? '') ||
      r.variants.length !== 2 ||
      r.variants[0]?.variant !== 'display' ||
      r.variants[1]?.variant !== 'thumbnail' ||
      ![r.width, r.height].every(
        (n) => typeof n === 'number' && Number.isSafeInteger(n) && n > 0 && n <= 8192,
      )
    )
      throw Error('INVALID_VALIDATOR_RESULT');
  } else if (r.variants.length) throw Error('INVALID_VALIDATOR_RESULT');
  if (
    [r.width, r.height].some(
      (n) => n !== undefined && (!Number.isSafeInteger(n) || n < 1 || n > 2147483647),
    )
  )
    throw Error('INVALID_VALIDATOR_RESULT');
  await mkdir(config.privateDirectory, { recursive: true, mode: 0o700 });
  const privateStat = await lstat(config.privateDirectory);
  if (!privateStat.isDirectory() || privateStat.isSymbolicLink())
    throw Error('INVALID_PRIVATE_DIRECTORY');
  const privatePath = resolve(config.privateDirectory, job.name);
  await mkdir(privatePath, { mode: 0o700 });
  await writeFile(
    resolve(privatePath, 'owner.json'),
    JSON.stringify({ protocol: 2, job: job.name, expiresAt: Date.now() + 3600000 }),
    { flag: 'wx', mode: 0o600 },
  );
  let total = 0;
  try {
    for (const v of r.variants) {
      const side = v.variant === 'display' ? 2048 : 512;
      if (
        ![v.width, v.height, v.bytes].every((n) => Number.isSafeInteger(n) && n > 0) ||
        (total += v.bytes) > 10 * 1024 ** 2 ||
        !/^[a-f0-9]{64}$/.test(v.sha256)
      )
        throw Error('INVALID_VALIDATOR_RESULT');
      // Bounded copy becomes exclusively worker-owned before validation or S3 publication.
      const data = await readBounded(resolve(job.output, v.variant + '.webp'), v.bytes);
      if (data.length !== v.bytes || createHash('sha256').update(data).digest('hex') !== v.sha256)
        throw Error('INVALID_DERIVATIVE_HASH');
      const dimensions = webpDimensions(data);
      if (
        dimensions.width !== v.width ||
        dimensions.height !== v.height ||
        v.width > side ||
        v.height > side
      )
        throw Error('INVALID_DERIVATIVE_DIMENSIONS');
      await writeFile(resolve(privatePath, v.variant + '.webp'), data, { flag: 'wx', mode: 0o600 });
    }
    return { result: r, privatePath };
  } catch (e) {
    await removePrivate(privatePath);
    throw e;
  }
}
export async function removePrivate(path: string) {
  for (const n of ['display.webp', 'thumbnail.webp', 'owner.json'])
    await unlink(resolve(path, n)).catch(() => {});
  await rmdir(path).catch(() => {});
}
export async function writeSource(
  job: ExchangeJob,
  source: AsyncIterable<Uint8Array>,
  expected: number,
  checksum: string,
  assertLease: () => void,
) {
  let bytes = 0;
  const h = createHash('sha256'),
    abort = new AbortController();
  const timeout = setTimeout(() => abort.abort(), 600000);
  const pulse = setInterval(() => {
    try {
      assertLease();
    } catch {
      abort.abort();
    }
  }, 500);
  try {
    await pipeline(
      source,
      new Transform({
        transform(chunk, _, done) {
          bytes += chunk.length;
          if (bytes > expected) return done(Error('INVALID_SOURCE_SIZE'));
          h.update(chunk);
          done(null, chunk);
        },
      }),
      createWriteStream(job.input + '.tmp', { flags: 'wx', mode: 0o600 }),
      { signal: abort.signal },
    );
    if (bytes !== expected || h.digest('base64') !== checksum) throw Error('FILE_SOURCE_CORRUPT');
    const file = await open(job.input + '.tmp', 'r+');
    try {
      await file.sync();
    } finally {
      await file.close();
    }
    await rename(job.input + '.tmp', job.input);
  } finally {
    clearTimeout(timeout);
    clearInterval(pulse);
  }
}
