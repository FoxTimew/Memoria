import { describe, expect, it } from 'vitest';
import { planBlocks, positionAfter } from './block-plan.ts';
import type { BlockState } from './block-plan.ts';
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const row = (n: number, parentId: string | null = null): BlockState => ({
  id: id(n),
  parentId,
  position: `a${n}`,
  type: 'core.paragraph',
  schemaVersion: 1,
  content: { spans: [] },
  deletedAt: null,
});
describe('block batch invariants', () => {
  it('rebalances exhausted fractional ranks within 128 characters', () => {
    const siblings = [
      { id: id(1), position: 'a0' },
      { id: id(2), position: `a0${'0'.repeat(125)}1` },
    ];
    const key = positionAfter(siblings, id(1));
    expect(key.length).toBeLessThanOrEqual(128);
    expect(key > siblings[0]!.position && key < siblings[1]!.position).toBe(true);
  });
  it('undo restores only explicit IDs and preserves older independent tombstones', () => {
    const first = new Date('2026-10-01');
    const second = new Date('2026-10-02');
    const archived = planBlocks(
      [row(1), row(2, id(1)), { ...row(3, id(1)), deletedAt: first }],
      [{ op: 'archive', id: id(1) }],
      second,
    );
    const restored = planBlocks(archived, [
      { op: 'restore', id: id(1), parentId: null, afterId: null, withDescendants: false },
      { op: 'restore', id: id(2), parentId: id(1), afterId: null, withDescendants: false },
    ]);
    expect(restored[0]?.deletedAt).toBeNull();
    expect(restored[1]?.deletedAt).toBeNull();
    expect(restored[2]?.deletedAt).toEqual(first);
  });
  it('rejects orphans, excessive depth and future schema versions before mutation', () => {
    const source = [row(1), row(2, id(1))];
    expect(() =>
      planBlocks(source, [{ op: 'move', id: id(1), parentId: id(2), afterId: null }]),
    ).toThrow('Cycle');
    expect(() =>
      planBlocks(source, [{ op: 'move', id: id(2), parentId: id(99), afterId: null }]),
    ).toThrow('absent');
    expect(() =>
      planBlocks(source, [{ op: 'update', id: id(2), schemaVersion: 99, content: { spans: [] } }]),
    ).toThrow('pris en charge');
    expect(source).toEqual([row(1), row(2, id(1))]);
    expect(() =>
      planBlocks(
        Array.from({ length: 53 }, (_, index) => row(index + 1, index ? id(index) : null)),
        [],
      ),
    ).toThrow('profondeur');
  });
});
