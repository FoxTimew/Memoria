import { describe, it, expect, vi } from 'vitest';
import { createHash } from 'node:crypto';
import {
  fileDigest,
  FileLifetime,
  riskyDownload,
  uploadFile,
  readPreview,
} from './file-transfer.ts';
describe('browser file transfer boundaries', () => {
  it('refuses active previews and caps decoded input buffers at 10 MiB', async () => {
    const mock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValueOnce(new Response('<script>', { headers: { 'Content-Type': 'text/html' } }))
      .mockResolvedValueOnce(
        new Response(new Uint8Array(10 * 1024 ** 2 + 1), {
          headers: { 'Content-Type': 'image/webp' },
        }),
      );
    try {
      await expect(
        readPreview('https://files.invalid/opaque', new AbortController().signal),
      ).rejects.toThrow('Aperçu indisponible');
      await expect(
        readPreview('https://files.invalid/opaque', new AbortController().signal),
      ).rejects.toThrow('volumineux');
    } finally {
      mock.mockRestore();
    }
  });
  it('hashes a multi-chunk file without reading more than 1 MiB into JS', async () => {
    const bytes = new Uint8Array(3 * 1024 ** 2 + 17).fill(127),
      blob = new Blob([bytes]);
    const original = blob.slice.bind(blob);
    let maximum = 0;
    vi.spyOn(blob, 'arrayBuffer').mockImplementation(() => {
      throw Error('whole blob forbidden');
    });
    vi.spyOn(blob, 'slice').mockImplementation((start, end) => {
      maximum = Math.max(maximum, (end ?? blob.size) - (start ?? 0));
      return original(start, end);
    });
    expect(await fileDigest(blob, new AbortController().signal)).toBe(
      createHash('sha256').update(bytes).digest('base64'),
    );
    expect(maximum).toBeLessThanOrEqual(1024 ** 2);
  });
  it('aborts before issuing any signature when a resumed file differs', async () => {
    const mock = vi
      .spyOn(globalThis, 'fetch')
      .mockResolvedValue(
        new Response(JSON.stringify({ bytes: 3, checksum: 'other' }), { status: 200 }),
      );
    try {
      await expect(
        uploadFile(
          '/upload',
          'page',
          new File(['abc'], 'same.png'),
          new AbortController().signal,
          () => {},
          'existing',
        ),
      ).rejects.toThrow('ne correspond pas');
      expect(mock).toHaveBeenCalledTimes(1);
    } finally {
      mock.mockRestore();
    }
  });
  it('rejects late responses after reset and permanently after logout', () => {
    const life = new FileLifetime(),
      before = life.capture();
    life.reset();
    expect(() => before.check()).toThrow();
    expect(() => life.capture().check()).not.toThrow();
    life.close();
    life.reset();
    expect(() => life.capture().check()).toThrow();
  });
  it('warns for executable/script/archive types, dangerous double extensions and unknown types', () => {
    for (const name of [
      'model.exe.png',
      'script.ps1',
      'backup.zip',
      'index.html',
      'icon.svg',
      'texture.png',
    ])
      expect(riskyDownload(name, 'application/octet-stream')).toBe(true);
    expect(riskyDownload('fake.exe.png', 'image/png')).toBe(true);
    expect(riskyDownload('photo.png', 'image/png')).toBe(false);
    expect(riskyDownload('script.js', 'text/plain')).toBe(true);
    expect(riskyDownload('photo.png', 'application/zip')).toBe(true);
  });
});
