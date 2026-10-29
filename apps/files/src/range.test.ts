import { it, expect } from 'vitest';
import { readRange } from './gateway.ts';
it('single bounded ranges only, suffix and open end supported', () => {
  expect(readRange(undefined, 100)).toBeUndefined();
  expect(readRange('bytes=2-6', 100)).toEqual({ start: 2, end: 6 });
  expect(readRange('bytes=-7', 100)).toEqual({ start: 93, end: 99 });
  expect(readRange('bytes=20-', 100)).toEqual({ start: 20, end: 99 });
  for (const s of [
    'bytes=-0',
    'bytes=100-',
    'bytes=5-4',
    'bytes=0-1,3-5',
    'items=0-1',
    'bytes=9007199254740992-',
  ])
    expect(() => readRange(s, 100)).toThrow('INVALID_RANGE');
});
