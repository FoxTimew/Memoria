import { it, expect } from 'vitest';
import { RoomBatchQueue } from './room-batch-queue.ts';
it('settles revalidated contributions individually without losing the healthy receipt', async () => {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let first = true;
  const queue = new RoomBatchQueue<number, number>(async (values) => {
    if (first) {
      first = false;
      await gate;
    }
    return values.map((v) => (v < 0 ? new Error('Invalid candidate') : v));
  });
  const pending = Promise.allSettled([queue.enqueue(1), queue.enqueue(-1), queue.enqueue(2)]);
  release();
  const result = await pending;
  expect(result.map((r) => r.status)).toEqual(['fulfilled', 'rejected', 'fulfilled']);
  expect(result[2]).toEqual({ status: 'fulfilled', value: 2 });
  expect(await queue.enqueue(3)).toBe(3);
});
