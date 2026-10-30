import { test } from 'node:test';
import assert from 'node:assert/strict';
import { imageFixture, decodeFixture, closeImageConverter } from './file-image-fixture.mjs';
const fixture = await imageFixture();
await test('sandbox validates actual format, strips metadata, bounds previews and never renders active originals', async (t) => {
  t.after(closeImageConverter);
  await t.test('real JPEG is reencoded without EXIF/GPS', async () => {
    const result = await decodeFixture(fixture + '/exif.jpg');
    assert.equal(result.status, 'validated', JSON.stringify(result));
    assert.equal(result.mime, 'image/jpeg');
    assert.equal(result.preview, 'available');
    assert.equal(result.variants.length, 2);
    assert(
      result.variants.every((v) => v.mime === 'image/webp' && v.width <= 2048 && v.height <= 2048),
    );
  });
  await t.test('HTML named JPEG is download-only', async () => {
    const result = await decodeFixture(fixture + '/fake.jpg');
    assert.equal(result.status, 'validated');
    assert.equal(result.mime, 'text/html');
    assert.deepEqual(result.variants, []);
  });
  await t.test('active SVG never reaches the raster decoder', async () => {
    const result = await decodeFixture(fixture + '/active.svg');
    assert.equal(result.status, 'validated');
    assert.equal(result.mime, 'image/svg+xml');
    assert.deepEqual(result.variants, []);
  });
  await t.test('8193 pixels is download-only without a large decode', async () => {
    const result = await decodeFixture(fixture + '/wide.png');
    assert.equal(result.status, 'validated');
    assert.equal(result.preview, 'dimensions');
    assert.deepEqual(result.variants, []);
  });
});
