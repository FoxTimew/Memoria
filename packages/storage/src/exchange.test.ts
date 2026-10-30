import { it, expect } from 'vitest';
import { mkdir, mkdtemp, writeFile, readFile, readdir, rm, link } from 'node:fs/promises';
import { resolve, sep } from 'node:path';
import { createHash } from 'node:crypto';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { setTimeout as delay } from 'node:timers/promises';
import {
  createExchangeJob,
  convertExchange,
  cleanupExchange,
  cleanupPrivate,
  removeJob,
  writeSource,
  readBounded,
  atomicFile,
} from './exchange.ts';
import { webpDimensions } from './derivative.ts';

it.runIf(process.platform === 'win32')(
  'atomic publication survives a real temporary Windows reader but fails closed for a persistent one',
  async () => {
    const f = await fixture();
    try {
      for (const temporary of [true, false]) {
        const path = resolve(f.root, temporary ? 'temporary.json' : 'persistent.json');
        await writeFile(path, '{"old":true}');
        const script =
          '$converterLock = [System.IO.File]::Open($env:MEMORIA_RENAME_TEST_FILE, [System.IO.FileMode]::Open, [System.IO.FileAccess]::Read, [System.IO.FileShare]::ReadWrite); try { [Console]::WriteLine("LOCKED"); [Console]::ReadLine() | Out-Null } finally { $converterLock.Dispose() }';
        const reader = spawn(
          'powershell.exe',
          ['-NoProfile', '-NonInteractive', '-Command', script],
          {
            windowsHide: true,
            stdio: ['pipe', 'pipe', 'pipe'],
            env: { ...process.env, MEMORIA_RENAME_TEST_FILE: path },
            timeout: 10000,
          },
        );
        const ended = once(reader, 'exit');
        try {
          const [message] = await once(reader.stdout, 'data');
          expect(message.toString()).toContain('LOCKED');
          const result = atomicFile(path, '{"new":true}').then(
            () => ({ ok: true as const }),
            (error: NodeJS.ErrnoException) => ({ ok: false as const, code: error.code }),
          );
          if (temporary) {
            await delay(35);
            expect(await readFile(path, 'utf8')).toBe('{"old":true}');
            reader.stdin.end('\n');
            await ended;
            expect(await result).toEqual({ ok: true });
            expect(await readFile(path, 'utf8')).toBe('{"new":true}');
          } else {
            const failed = await result;
            expect(failed.ok).toBe(false);
            if (!failed.ok) expect(['EPERM', 'EACCES', 'EBUSY']).toContain(failed.code);
            expect(await readFile(path, 'utf8')).toBe('{"old":true}');
            expect(await readFile(path + '.tmp', 'utf8')).toBe('{"new":true}');
          }
        } finally {
          if (reader.exitCode === null) {
            reader.stdin.end('\n');
            await ended;
          }
        }
      }
    } finally {
      await f.close();
    }
  },
  30000,
);

async function fixture() {
  const parent = resolve('.local/exchange-unit');
  await mkdir(parent, { recursive: true });
  const root = await mkdtemp(parent + sep + 'run-');
  if (!root.startsWith(parent + sep)) throw Error('TEST_PATH');
  const config = {
    directory: resolve(root, 'exchange'),
    privateDirectory: resolve(root, 'private'),
    budgetBytes: 64 * 1024 ** 2,
  };
  return {
    root,
    config,
    async close() {
      await rm(root, { recursive: true, force: true });
    },
  };
}
// Minimal envelopes exercise the worker parser, not the entropy decoder (real images are e2e).
function raster(width = 100, height = 80) {
  const b = Buffer.alloc(30);
  b.write('RIFF');
  b.writeUInt32LE(22, 4);
  b.write('WEBPVP8 ', 8);
  b.writeUInt32LE(10, 16);
  Buffer.from([0x9d, 1, 0x2a]).copy(b, 23);
  b.writeUInt16LE(width, 26);
  b.writeUInt16LE(height, 28);
  return b;
}
it('rejects active, metadata-bearing, animated, truncated or oversized WebP envelopes', () => {
  expect(webpDimensions(raster())).toEqual({ width: 100, height: 80 });
  for (const transform of [
    (b: Buffer) => {
      b.write('EXIF', 12);
      return b;
    },
    (b: Buffer) => {
      b.write('ANIM', 12);
      return b;
    },
    (b: Buffer) => Buffer.concat([b, Buffer.from('html')]),
    (b: Buffer) => b.subarray(0, 29),
  ])
    expect(() => webpDimensions(transform(raster()))).toThrow('FORMAT');
});
it('bounds disk admission and blocks all residue, then cleans only expired recognized jobs', async () => {
  const f = await fixture();
  try {
    await expect(createExchangeJob(f.config, 100 * 1024 ** 2)).rejects.toThrow('CAPACITY');
    const job = await createExchangeJob(f.config, 10);
    await expect(createExchangeJob(f.config, 10)).rejects.toThrow('BUSY');
    expect(await cleanupExchange(f.config.directory)).toBe(0);
    expect(await cleanupExchange(f.config.directory, Date.now() + 700000)).toBe(1);
    await mkdir(job.path);
    await writeFile(resolve(job.path, 'owner.json.tmp'), '{partial');
    expect(await cleanupExchange(f.config.directory, Date.now() + 700000)).toBe(1);
    await writeFile(resolve(f.config.directory, 'unknown'), 'private residue');
    await expect(createExchangeJob(f.config, 10)).rejects.toThrow('BUSY');
    expect(await cleanupExchange(f.config.directory, Date.now() + 700000)).toBe(0);
    expect(await readFile(resolve(f.config.directory, 'unknown'), 'utf8')).toBe('private residue');
    expect(job.name).toMatch(/^job-/);
  } finally {
    await f.close();
  }
});
it('partial source never becomes an atomic request; hard links are refused', async () => {
  const f = await fixture();
  try {
    const job = await createExchangeJob(f.config, 4);
    await expect(
      writeSource(
        job,
        (async function* () {
          yield Buffer.from('wrong');
        })(),
        4,
        'wrong',
        () => {},
      ),
    ).rejects.toThrow('SIZE');
    expect(await readdir(job.path)).not.toContain('request.json');
    await writeFile(resolve(f.root, 'target'), 'secret');
    await link(resolve(f.root, 'target'), resolve(f.root, 'alias'));
    await expect(readBounded(resolve(f.root, 'alias'), 100)).rejects.toThrow('EXCHANGE_FILE');
  } finally {
    await f.close();
  }
});
it('hostile converter results are rejected; publication uses an immutable private snapshot', async () => {
  const f = await fixture();
  try {
    for (const attack of [
      'nonce',
      'expired',
      'mime',
      'size',
      'hash',
      'dimensions',
      'active',
      'valid',
    ]) {
      const job = await createExchangeJob(f.config, 3);
      await writeFile(job.input, Buffer.from([255, 216, 255]));
      const image = attack === 'active' ? Buffer.from('<svg><script/></svg>') : raster();
      const v = {
        bytes: image.length,
        width: 100,
        height: 80,
        sha256: createHash('sha256').update(image).digest('hex'),
      };
      const r = {
        status: 'validated',
        mime: attack === 'mime' ? 'text/html' : 'image/jpeg',
        preview: 'available',
        width: 100,
        height: 80,
        variants: [
          { ...v, variant: 'display' },
          { ...v, variant: 'thumbnail' },
        ],
      };
      if (attack === 'size') r.variants[0]!.bytes = 20 * 1024 ** 2;
      if (attack === 'hash') r.variants[0]!.sha256 = 'a'.repeat(64);
      if (attack === 'dimensions') r.variants[0]!.width = 99;
      for (const name of ['display', 'thumbnail'])
        await writeFile(resolve(job.output, name + '.webp'), image);
      const attempt = convertExchange(job, f.config, 3, () => {});
      // Attach a rejection handler immediately; attack responses arrive asynchronously.
      const settled = attempt.then(
        (value) => ({ value }),
        (error) => ({ error }),
      );
      let request;
      for (let n = 0; n < 100; n++) {
        try {
          request = JSON.parse(await readFile(resolve(job.path, 'request.json'), 'utf8'));
          break;
        } catch {
          await delay(5);
        }
      }
      expect(request).toBeTruthy();
      await atomicFile(
        resolve(job.path, 'result.json'),
        JSON.stringify({
          ...request,
          nonce: attack === 'nonce' ? 'b'.repeat(64) : request.nonce,
          expiresAt: attack === 'expired' ? 1 : request.expiresAt,
          result: r,
        }),
      );
      const outcome = await settled;
      if (attack !== 'valid') expect('error' in outcome).toBe(true);
      else {
        expect('value' in outcome).toBe(true);
        if ('value' in outcome) {
          await writeFile(resolve(job.output, 'display.webp'), 'changed after verification');
          expect(await readFile(resolve(outcome.value.privatePath!, 'display.webp'))).toEqual(
            image,
          );
        }
        await cleanupPrivate(f.config.privateDirectory, Date.now() + 7200000);
        expect(await readdir(f.config.privateDirectory)).toEqual([]);
      }
      await removeJob(job.path);
    }
  } finally {
    await f.close();
  }
});
