import { expect, test } from 'vitest';
import {
  databaseLimitDefaults,
  databaseLimitVariable,
  readDatabaseLimits,
} from './database-limits.ts';
test('every bound is a validated deployment setting, with documented defaults', () => {
  expect(readDatabaseLimits({})).toEqual(databaseLimitDefaults);
  for (const key of Object.keys(databaseLimitDefaults)) {
    const variable = databaseLimitVariable(key);
    const baseline = {
      DATABASE_ROWS_PER_BASE: '1',
      DATABASE_ROWS_PER_WORKSPACE: '999999',
      DATABASE_PAGE_SIZE: '1',
      DATABASE_MAX_PAGE_SIZE: '999999',
    };
    expect(
      readDatabaseLimits({ ...baseline, [variable]: '120' })[
        key as keyof typeof databaseLimitDefaults
      ],
    ).toBe(120);
    for (const invalid of ['0', '-1', 'NaN', '1.5', '100x', '9007199254740992'])
      expect(() => readDatabaseLimits({ [variable]: invalid })).toThrow(variable);
  }
  expect(() => readDatabaseLimits({ DATABASE_ROWS_PER_BASE: '50001' })).toThrow('Inconsistent');
});
