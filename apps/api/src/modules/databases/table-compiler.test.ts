import { describe, it, expect } from 'vitest';
import { randomUUID } from 'node:crypto';
import { signTableCursor, readTableCursor } from './table-compiler.ts';
import { DatabaseAdmission } from './database-quota.ts';
describe('table boundary helpers', () => {
  it('authenticates cursor scope, signature and value encoding', () => {
    const token = signTableCursor('secret', 'actor-schema-query', ['<script>', null], randomUUID());
    expect(readTableCursor('secret', token, 'actor-schema-query')?.keys).toEqual([
      '<script>',
      null,
    ]);
    expect(() => readTableCursor('another', token, 'actor-schema-query')).toThrow(
      'TABLE_CURSOR_STALE',
    );
    expect(() => readTableCursor('secret', token, 'other-scope')).toThrow('TABLE_CURSOR_STALE');
    expect(() => readTableCursor('secret', token + '.suffix', 'actor-schema-query')).toThrow(
      'TABLE_CURSOR_STALE',
    );
  });
  it('bounds the queue and hands the reserved slot over even when work rejects', async () => {
    const gate = new DatabaseAdmission(1, 1, 1000);
    let release!: () => void;
    const first = gate.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    const second = gate.run(async () => {
      throw new Error('query failed');
    });
    const rejection = expect(second).rejects.toThrow('query failed');
    await expect(gate.run(async () => 1)).rejects.toThrow();
    release();
    await first;
    await rejection;
    expect(await gate.run(async () => 2)).toBe(2);
  });
  it('removes timed-out waiters instead of executing them later', async () => {
    const gate = new DatabaseAdmission(1, 1, 10);
    let release!: () => void,
      ran = false;
    const first = gate.run(
      () =>
        new Promise<void>((r) => {
          release = r;
        }),
    );
    await expect(
      gate.run(async () => {
        ran = true;
      }),
    ).rejects.toThrow();
    release();
    await first;
    expect(ran).toBe(false);
    expect(await gate.run(async () => 3)).toBe(3);
  });
});
