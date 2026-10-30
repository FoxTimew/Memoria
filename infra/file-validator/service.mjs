import { spawn } from 'node:child_process';
import { mkdir, readdir, lstat, open, rename, unlink, rmdir } from 'node:fs/promises';
import { setTimeout, clearTimeout } from 'node:timers';
import { setTimeout as delay } from 'node:timers/promises';
import { join } from 'node:path';
const root = '/exchange',
  scratch = '/scratch';
const jobName = /^job-[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/;
const maxOutput = 10 * 1024 ** 2;
let stopping = false,
  active;
const plain = async (path, max) => {
  const st = await lstat(path);
  if (!st.isFile() || st.isSymbolicLink() || st.nlink !== 1 || st.size > max)
    throw Error('INVALID_JOB');
  const handle = await open(path, 'r');
  try {
    const actual = await handle.stat();
    if (actual.ino !== st.ino || actual.dev !== st.dev || actual.size !== st.size)
      throw Error('INVALID_JOB');
    const bytes = Buffer.alloc(st.size + 1);
    let bytesRead = 0;
    while (bytesRead < bytes.length) {
      const r = await handle.read(bytes, bytesRead, bytes.length - bytesRead, bytesRead);
      if (!r.bytesRead) break;
      bytesRead += r.bytesRead;
    }
    if (bytesRead !== st.size) throw Error('INVALID_JOB');
    return bytes.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
};
async function atomic(path, value) {
  const temp = path + '.tmp';
  const h = await open(temp, 'wx', 0o600);
  try {
    await h.writeFile(value);
    await h.sync();
  } finally {
    await h.close();
  }
  await rename(temp, path);
}
function kill() {
  if (active?.pid)
    try {
      process.kill(-active.pid, 'SIGKILL');
    } catch {
      /* already gone */
    }
}
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    stopping = true;
    kill();
  });
async function clearScratch() {
  // The decoder cannot create directories/links or escape this bounded tmpfs (Landlock).
  for (const name of await readdir(scratch)) {
    const path = join(scratch, name),
      st = await lstat(path);
    if (!st.isFile() || st.isSymbolicLink()) throw Error('INVALID_SCRATCH');
    await unlink(path);
  }
}
async function cleanup(path) {
  const names = [
    'owner.json',
    'owner.json.tmp',
    'cancel.json',
    'request.json',
    'request.json.tmp',
    'running.json',
    'result.json',
    'result.json.tmp',
  ];
  if ((await readdir(path)).some((n) => ![...names, 'input', 'output'].includes(n))) return;
  for (const [part, allowed] of [
    ['input', ['source', 'source.tmp']],
    ['output', ['display.webp', 'thumbnail.webp', 'display.webp.tmp', 'thumbnail.webp.tmp']],
  ]) {
    const directory = join(path, part);
    const st = await lstat(directory).catch(() => null);
    if (!st) continue;
    if (!st.isDirectory() || st.isSymbolicLink()) return;
    const children = await readdir(directory);
    if (children.some((n) => !allowed.includes(n))) return;
    for (const n of children) {
      const f = join(directory, n),
        info = await lstat(f);
      if (!info.isFile() || info.isSymbolicLink() || info.nlink !== 1) return;
    }
  }
  for (const part of ['input', 'output']) {
    const directory = join(path, part);
    for (const n of await readdir(directory).catch(() => [])) await unlink(join(directory, n));
    await rmdir(directory).catch(() => {});
  }
  for (const n of names) await unlink(join(path, n)).catch(() => {});
  await rmdir(path).catch(() => {});
}
async function work(name) {
  // One mount, one task: no cross-workspace residue is ever visible to a decoder.
  if ((await readdir(root)).some((n) => n !== name)) throw Error('EXCHANGE_NOT_EXCLUSIVE');
  const path = join(root, name),
    st = await lstat(path);
  if (!st.isDirectory() || st.isSymbolicLink()) return;
  let owner;
  try {
    owner = JSON.parse((await plain(join(path, 'owner.json'), 1024)).toString());
  } catch {
    const names = await readdir(path);
    if (st.mtimeMs < Date.now() - 600000 && names.every((n) => n === 'owner.json.tmp'))
      await cleanup(path);
    return;
  }
  if (owner.protocol !== 2 || owner.job !== name || !Number.isSafeInteger(owner.expiresAt)) return;
  if (owner.expiresAt < Date.now()) {
    await cleanup(path);
    return;
  }
  if (await lstat(join(path, 'result.json')).catch(() => null)) return;
  let request,
    interrupted = false;
  try {
    request = JSON.parse((await plain(join(path, 'request.json'), 4096)).toString());
  } catch {
    if (!(await lstat(join(path, 'running.json')).catch(() => null))) return;
    request = JSON.parse((await plain(join(path, 'running.json'), 4096)).toString());
    interrupted = true; // A previous supervisor died. Never reuse a partial decode.
  }
  if (
    Object.keys(request).sort().join(',') !== 'bytes,expiresAt,job,nonce,protocol' ||
    request.protocol !== 2 ||
    request.job !== name ||
    !/^[a-f0-9]{64}$/.test(request.nonce) ||
    !Number.isSafeInteger(request.bytes) ||
    request.bytes < 1 ||
    request.bytes > 5 * 1024 ** 3 ||
    !Number.isSafeInteger(request.expiresAt) ||
    request.expiresAt > Date.now() + 65000
  )
    throw Error('INVALID_JOB');
  if (request.expiresAt < Date.now()) {
    await cleanup(path);
    return;
  }
  if (!interrupted) await rename(join(path, 'request.json'), join(path, 'running.json'));
  let result;
  await clearScratch();
  try {
    const input = join(path, 'input', 'source'),
      inputStat = await lstat(input);
    const output = join(path, 'output'),
      outStat = await lstat(output);
    if (
      inputStat.isSymbolicLink() ||
      !inputStat.isFile() ||
      inputStat.nlink !== 1 ||
      inputStat.size !== request.bytes ||
      outStat.isSymbolicLink() ||
      !outStat.isDirectory() ||
      (await readdir(output)).length
    )
      throw Error('INVALID_JOB');
    if (interrupted) throw Error('INTERRUPTED_JOB');
    const code = await new Promise((resolve, reject) => {
      active = spawn(
        '/validator/isolate',
        [
          '--decode',
          input,
          scratch,
          'node',
          '--max-old-space-size=96',
          '/validator/validate.mjs',
          input,
          scratch,
        ],
        {
          detached: true,
          stdio: ['ignore', 'ignore', 'ignore'],
          env: {
            PATH: '/usr/local/bin:/usr/bin:/bin',
            MALLOC_ARENA_MAX: '2',
            UV_THREADPOOL_SIZE: '1',
            TMPDIR: scratch,
          },
        },
      );
      const timer = setTimeout(kill, Math.min(30000, request.expiresAt - Date.now()));
      active.once('error', (e) => {
        clearTimeout(timer);
        reject(e);
      });
      active.once('exit', (code) => {
        clearTimeout(timer);
        kill();
        active = undefined;
        resolve(code);
      });
    });
    if (code !== 0 || stopping || request.expiresAt < Date.now())
      throw Error('DECODER_UNAVAILABLE');
    result = JSON.parse((await plain(join(scratch, 'result.json'), 16384)).toString());
    let total = 0;
    if (result.status === 'validated')
      for (const variant of ['display', 'thumbnail']) {
        const source = join(scratch, variant + '.webp');
        if (!(await lstat(source).catch(() => null))) continue;
        const bytes = await plain(source, maxOutput);
        if ((total += bytes.length) > maxOutput) throw Error('OUTPUT_LIMIT');
        await atomic(join(output, variant + '.webp'), bytes);
      }
  } catch {
    result = { status: 'retry', variants: [] };
  } finally {
    kill();
    active = undefined;
    await clearScratch();
  }
  await atomic(
    join(path, 'result.json'),
    JSON.stringify({
      protocol: 2,
      job: name,
      nonce: request.nonce,
      expiresAt: request.expiresAt,
      result,
    }) + '\n',
  );
}
await mkdir(scratch, { recursive: true });
await clearScratch();
console.info('Converter ready; private exchange, no network, one decoder');
while (!stopping) {
  for (const name of (await readdir(root)).filter((n) => jobName.test(n))) {
    if (stopping) break;
    try {
      await work(name);
    } catch {
      console.warn('CONVERTER_JOB_UNAVAILABLE');
    }
  }
  await delay(250); // Polling also works across Windows bind mounts.
}
