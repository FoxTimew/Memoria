import { open, writeFile } from 'node:fs/promises';
import { createDeflate, crc32 } from 'node:zlib';
import sharp from 'sharp';
sharp.cache(false);
sharp.concurrency(1);
const dir = '/output';
if (process.argv[2] === 'large') {
  // Deterministic xorshift RGB noise, streamed in 24 KiB rows. Not a giant JS Buffer.
  for (const profile of ['noise', 'solid']) {
    const file = await open(dir + '/' + profile + '.png', 'w'),
      deflate = createDeflate({ level: 1 });
    const chunk = async (kind, data) => {
      const prefix = Buffer.alloc(8),
        suffix = Buffer.alloc(4);
      prefix.writeUInt32BE(data.length);
      prefix.write(kind, 4);
      suffix.writeUInt32BE(crc32(data, crc32(Buffer.from(kind))));
      await file.write(prefix);
      await file.write(data);
      await file.write(suffix);
    };
    await file.write(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
    const header = Buffer.alloc(13);
    header.writeUInt32BE(8192);
    header.writeUInt32BE(8192, 4);
    header[8] = 8;
    header[9] = 2;
    await chunk('IHDR', header);
    const produce = (async () => {
      const row = Buffer.alloc(8192 * 3 + 1);
      let state = 0x7b8192;
      for (let y = 0; y < 8192; y++) {
        for (let i = 1; i < row.length; i++) {
          state ^= state << 13;
          state ^= state >>> 17;
          state ^= state << 5;
          row[i] = profile === 'noise' ? state & 255 : [0x44, 0x88, 0xaa][(i - 1) % 3];
        }
        await new Promise((resolve, reject) =>
          deflate.write(row, (e) => (e ? reject(e) : resolve())),
        );
      }
      deflate.end();
    })();
    try {
      for await (const bytes of deflate) await chunk('IDAT', bytes);
      await produce;
      await chunk('IEND', Buffer.alloc(0));
    } finally {
      await file.close();
    }
  }
} else {
  await sharp({ create: { width: 100, height: 80, channels: 3, background: '#4488aa' } })
    .withExif({
      IFD0: { Artist: 'PRIVATE_ARTIST' },
      IFD3: { GPSLatitudeRef: 'N', GPSLatitude: '48/1 0/1 0/1' },
    })
    .jpeg()
    .toFile(dir + '/exif.jpg');
  await sharp({ create: { width: 8193, height: 10, channels: 3, background: '#ffffff' } })
    .png()
    .toFile(dir + '/wide.png');
  await writeFile(
    dir + '/active.svg',
    '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
  );
  await writeFile(dir + '/fake.jpg', '<html><script>alert(1)</script></html>');
}
