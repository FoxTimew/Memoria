import { expect, it } from 'vitest';
import { assessRegression } from './measurement-regression.mjs';

it('uses the 2 ms allowance for fast operations, including equality', () => {
  expect(assessRegression(8, 10)).toMatchObject({
    allowedRegressionMs: 2,
    exceedsRegression: false,
  });
  expect(assessRegression(8, 10.001).exceedsRegression).toBe(true);
});
it('uses ten percent when it is larger, without adding both allowances', () => {
  expect(assessRegression(100, 110)).toMatchObject({
    allowedRegressionMs: 10,
    exceedsRegression: false,
  });
  expect(assessRegression(100, 110.001).exceedsRegression).toBe(true);
  expect(assessRegression(20, 22).exceedsRegression).toBe(false);
});
it('accepts improvements and rejects invalid or missing measurements', () => {
  expect(assessRegression(100, 90).exceedsRegression).toBe(false);
  for (const values of [
    [0, 1],
    [NaN, 1],
    [100, NaN],
    [100, Infinity],
    [100, -1],
  ])
    expect(() => assessRegression(...values)).toThrow('Invalid latency');
});
