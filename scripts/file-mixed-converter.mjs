import {
  imageFixture,
  startImageConverter,
  decodeFixture,
  closeImageConverter,
} from './file-image-fixture.mjs';
import { setTimeout as delay } from 'node:timers/promises';
const fixture = await imageFixture(true);
await startImageConverter();
let stopping = false;
process.on('disconnect', () => {
  stopping = true;
});
process.on('message', (m) => {
  if (m.kind === 'stop') stopping = true;
});
process.send?.({ kind: 'prepared' });
await new Promise((resolve) => process.once('message', resolve));
let i = 0;
try {
  while (!stopping) {
    const profile = i++ % 2 ? 'solid' : 'noise';
    const result = await decodeFixture(fixture + '/' + profile + '.png');
    process.send?.({ kind: 'conversion', result: { profile, ...result, output: undefined } });
    if (
      result.status !== 'validated' ||
      result.preview !== 'available' ||
      result.elapsedMs >= 30000 ||
      result.cgroupPeakBytes > 512 * 1024 ** 2
    )
      throw Error('STOP_CONVERTER_LIMIT');
    await delay(100);
  }
} catch (e) {
  process.send?.({ kind: 'failure', error: e.message });
  process.exitCode = 1;
} finally {
  await closeImageConverter();
  process.disconnect?.();
}
