import { describe, expect, it } from 'vitest';
import * as Y from 'yjs';
import { RoomBatchQueue } from './room-batch-queue.ts';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}
describe('pending room batch', () => {
  it('merges waiting updates once, resolves every caller only after commit, and converges', async () => {
    const gate = barrier(),
      doc = new Y.Doc(),
      sizes: number[] = [],
      calls: string[] = [];
    const queue = new RoomBatchQueue<Uint8Array, number>(async (updates) => {
      sizes.push(updates.length);
      if (sizes.length === 1) await gate.promise;
      const merged = Y.mergeUpdates(updates);
      calls.push('validated');
      calls.push('committed');
      Y.applyUpdate(doc, merged);
      return updates.map(() => sizes.length);
    });
    const clients = Array.from({ length: 3 }, () => new Y.Doc());
    const promises = clients.map((client, i) => {
      client.getMap('fields').set(String(i), i);
      return queue.enqueue(Y.encodeStateAsUpdate(client)).then((revision) => {
        expect(calls).toContain('committed');
        return revision;
      });
    });
    expect(doc.getMap('fields').size).toBe(0);
    expect(sizes).toEqual([1]);
    gate.release();
    expect(await Promise.all(promises)).toEqual([1, 2, 2]);
    expect(sizes).toEqual([1, 2]);
    expect(doc.getMap('fields').size).toBe(3);
    for (const client of clients) {
      Y.applyUpdate(client, Y.encodeStateAsUpdate(doc));
      expect(client.getMap('fields').toJSON()).toEqual(doc.getMap('fields').toJSON());
      client.destroy();
    }
    doc.destroy();
  });
  it('rejects all callers of a failed batch and keeps later work runnable', async () => {
    const gate = barrier();
    let runs = 0;
    const queue = new RoomBatchQueue<number, number>(async (values) => {
      runs++;
      if (runs === 1) await gate.promise;
      if (values.includes(-1)) throw new Error('Invalid candidate');
      return values;
    });
    const first = queue.enqueue(0),
      second = queue.enqueue(-1),
      third = queue.enqueue(2);
    const rejected = Promise.allSettled([second, third]);
    gate.release();
    await first;
    expect((await rejected).map((r) => r.status)).toEqual(['rejected', 'rejected']);
    expect(await queue.enqueue(3)).toBe(3);
  });
  it('bounds pending entries without dropping accepted callers', async () => {
    const gate = barrier();
    const queue = new RoomBatchQueue<number, number>(async (values) => {
      await gate.promise;
      return values;
    }, 1);
    const first = queue.enqueue(1),
      second = queue.enqueue(2);
    await expect(queue.enqueue(3)).rejects.toThrow('Room queue full');
    gate.release();
    expect(await Promise.all([first, second])).toEqual([1, 2]);
  });
});
