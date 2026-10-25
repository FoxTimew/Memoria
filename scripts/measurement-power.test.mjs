import { describe, expect, it, vi } from 'vitest';
import {
  assessMeasurementPower,
  assertMeasurementPower,
  readMeasurementPower,
} from './measurement-power.mjs';

describe('mandatory AC power for performance measurements', () => {
  it('accepts only an explicit numeric status 2 for every battery', () => {
    expect(assessMeasurementPower({ BatteryStatus: 2 }).allowed).toBe(true);
    expect(assessMeasurementPower([{ BatteryStatus: 2 }, { BatteryStatus: 2 }]).allowed).toBe(true);
    expect(assessMeasurementPower([{ BatteryStatus: 2 }, { BatteryStatus: 1 }]).allowed).toBe(
      false,
    );
  });

  it.each([1, 3, 6, 0, 11, '2', null, undefined])('refuses status %s', (status) => {
    const observation = assessMeasurementPower({ BatteryStatus: status });
    expect(observation.allowed).toBe(false);
    expect(() => assertMeasurementPower(observation)).toThrow('Branche le portable sur secteur');
    try {
      assertMeasurementPower(observation);
    } catch (error) {
      expect(error.exitCode).toBe(3);
      expect(error.observation).toBe(observation);
    }
  });

  it('does not infer AC power from missing batteries, a full charge or a broken probe', () => {
    for (const rows of [null, [], {}, { EstimatedChargeRemaining: 100 }])
      expect(assessMeasurementPower(rows).allowed).toBe(false);
    for (const query of [
      () => '',
      () => '{invalid',
      () => {
        throw new Error('CIM failure');
      },
    ]) {
      const result = readMeasurementPower({ hostPlatform: 'win32', query });
      expect(result).toMatchObject({ allowed: false, reason: 'POWER_PROBE_FAILED' });
    }
  });

  it('records each new observation instead of reusing a prior successful reading', () => {
    const query = vi
      .fn()
      .mockReturnValueOnce('{"BatteryStatus":2}')
      .mockReturnValueOnce('{"BatteryStatus":1}');
    const first = readMeasurementPower({ hostPlatform: 'win32', query });
    const next = readMeasurementPower({ hostPlatform: 'win32', query });
    expect(() => assertMeasurementPower(first)).not.toThrow();
    expect(() => assertMeasurementPower(next)).toThrow();
    expect(query).toHaveBeenCalledTimes(2);
    expect(Number.isFinite(Date.parse(next.observedAt))).toBe(true);
    expect(next.batteries).toEqual([{ BatteryStatus: 1 }]);
  });

  it('fails closed on an unsupported host rather than treating no battery as AC', () => {
    const query = vi.fn();
    expect(readMeasurementPower({ hostPlatform: 'linux', query })).toMatchObject({
      allowed: false,
      reason: 'POWER_PROBE_UNSUPPORTED',
    });
    expect(query).not.toHaveBeenCalled();
  });
});
