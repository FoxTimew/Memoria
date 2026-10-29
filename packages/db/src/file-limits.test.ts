import { it, expect } from 'vitest';
import { readFileLimits } from './file-limits.ts';
it('file deployment settings are configurable and malformed or inconsistent values fail closed', () => {
  expect(readFileLimits({}).maxBytes).toBe(5 * 1024 ** 3);
  expect(readFileLimits({ FILES_MAX_BYTES: '12345' }).maxBytes).toBe(12345);
  expect(
    readFileLimits({ FILES_STAGING_BYTES: '12345', FILES_CAPACITY_BYTES: '23456' }),
  ).toMatchObject({ stagingBytes: 12345, capacityBytes: 23456 });
  for (const raw of ['0', '-1', '1.5', '1e9', '9007199254740992', ''])
    expect(() => readFileLimits({ FILES_MAX_BYTES: raw })).toThrow();
  expect(() => readFileLimits({ FILES_ACTIVE_PARTS: '21' })).toThrow();
});
