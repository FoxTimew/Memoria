import { open, stat, writeFile, readFile, unlink } from 'node:fs/promises';
import { createReadStream } from 'node:fs';
import { createHash } from 'node:crypto';
import sharp from 'sharp';
import { fileTypeFromFile } from 'file-type';

// One sandbox / one source. No name, MIME, URL, token or storage credential enters this process.
sharp.cache(false);
sharp.concurrency(1);
sharp.block({ operation: ['VipsForeignLoad'] });
sharp.unblock({
  operation: ['VipsForeignLoadJpegFile', 'VipsForeignLoadPngFile', 'VipsForeignLoadWebpFile'],
});
const input = process.argv[2] ?? '/input/source',
  out = process.argv[3] ?? '/output';
const maximum = 5 * 1024 ** 3,
  maxPixels = 8192 ** 2;
const started = performance.now();
const hashFile = async (path) => {
  const hash = createHash('sha256');
  for await (const chunk of createReadStream(path)) hash.update(chunk);
  return hash.digest('hex');
};
const result = { status: 'rejected', code: 'FILE_FORMAT_REJECTED', variants: [] };
try {
  const size = (await stat(input)).size;
  if (size < 1 || size > maximum) throw Error('size');
  const source = await open(input, 'r'),
    head = Buffer.alloc(8192);
  let n;
  try {
    n = (await source.read(head)).bytesRead;
  } finally {
    await source.close();
  }
  const text = head
    .subarray(0, n)
    .toString('utf8')
    .replace(/^\uFEFF/, '')
    .trimStart();
  const detected = await fileTypeFromFile(input);
  let mime = detected?.mime ?? 'application/octet-stream';
  if (/^(?:<\?xml\b[^>]*>\s*)?<svg\b/i.test(text)) mime = 'image/svg+xml';
  else if (/^(?:<!doctype\s+html|<html\b|<script\b)/i.test(text)) mime = 'text/html';
  // Scripts/text cannot be classified reliably; unknown always remains download-only.
  result.mime = mime;
  result.preview = 'unsupported';
  if (['image/jpeg', 'image/png', 'image/webp'].includes(mime)) {
    const meta = await sharp(input, { limitInputPixels: false, failOn: 'warning' }).metadata();
    const width = meta.width,
      height = meta.height;
    if (!width || !height || !Number.isSafeInteger(width * height)) throw Error('dimensions');
    result.width = width;
    result.height = height;
    if ((meta.pages ?? 1) !== 1) result.preview = 'multiple-frames';
    else if (width > 8192 || height > 8192 || width * height > maxPixels)
      result.preview = 'dimensions';
    else {
      const decodeStart = performance.now();
      for (const [variant, side] of [
        ['display', 2048],
        ['thumbnail', 512],
      ]) {
        const target = out + '/' + variant + '.webp';
        const info = await sharp(input, {
          limitInputPixels: maxPixels,
          limitInputChannels: 4,
          failOn: 'warning',
          sequentialRead: true,
        })
          .rotate()
          .resize({ width: side, height: side, fit: 'inside', withoutEnlargement: true })
          .webp({ quality: 85, effort: 2 })
          .timeout({ seconds: 25 })
          .toFile(target);
        if (info.size > 10 * 1024 ** 2) throw Error('derivative budget');
        const check = await sharp(target).metadata();
        if (check.exif || check.xmp || check.icc || check.iptc || (check.pages ?? 1) !== 1)
          throw Error('metadata');
        result.variants.push({
          variant,
          mime: 'image/webp',
          bytes: info.size,
          width: info.width,
          height: info.height,
          sha256: await hashFile(target),
        });
      }
      if (result.variants.reduce((sum, v) => sum + v.bytes, 0) > 10 * 1024 ** 2)
        throw Error('derivative total');
      result.decodeAndEncodeMs = performance.now() - decodeStart;
      result.preview = 'available';
    }
  }
  result.status = 'validated';
  delete result.code;
} catch {
  result.status = 'rejected';
  result.code = 'FILE_FORMAT_REJECTED';
  result.variants = [];
  for (const name of ['display', 'thumbnail'])
    await unlink(out + '/' + name + '.webp').catch(() => {});
}
result.elapsedMs = performance.now() - started;
result.maxRssKiB = process.resourceUsage().maxRSS;
result.cgroupPeakBytes = Number(await readFile('/sys/fs/cgroup/memory.peak', 'utf8'));
result.versions = { sharp: sharp.versions.sharp, vips: sharp.versions.vips };
await writeFile(out + '/result.json', JSON.stringify(result) + '\n', { flag: 'wx' });
console.info(
  JSON.stringify({
    status: result.status,
    preview: result.preview,
    elapsedMs: result.elapsedMs,
    maxRssKiB: result.maxRssKiB,
    cgroupPeakBytes: result.cgroupPeakBytes,
  }),
);
