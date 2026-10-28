import { expect, test } from 'vitest';
import { parseContainerStats } from './measurement-container.mjs';
test('Docker metrics accept both Windows ANSI redraw and plain JSON, never silently accept missing CPU', () => {
  const json = JSON.stringify({
    CPUPerc: '6.78%',
    MemUsage: '298MiB / 6.697GiB',
    BlockIO: '1GB / 9GB',
  });
  const wanted = { cpu: '6.78%', memory: '298MiB / 6.697GiB', io: '1GB / 9GB' };
  expect(parseContainerStats(json)).toEqual(wanted);
  expect(parseContainerStats('\x1b[H' + json + '\x1b[K')).toEqual(wanted);
  expect(parseContainerStats('\x1b[K\x1b[J')).toBeUndefined();
  expect(() => parseContainerStats('{"CPUPerc":"unknown"}')).toThrow('INVALID_CONTAINER_STATS');
  expect(() => parseContainerStats('{broken')).toThrow();
});
