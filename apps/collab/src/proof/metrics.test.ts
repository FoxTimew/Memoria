import { describe, expect, it } from 'vitest';
import { IncomingMessage, OutgoingMessage } from '@hocuspocus/server';
import * as Y from 'yjs';
import { QueueMetrics, distribution, ordinaryUpdate, updateReceipt } from './metrics.ts';

describe('load measurement', () => {
  it('counts ingress hidden in per-connection queues until each acknowledgement', () => {
    const doc = new Y.Doc(),
      updates: Uint8Array[] = [];
    doc.on('update', (u: Uint8Array) => updates.push(u));
    doc.getText('x').insert(0, 'a');
    doc.getText('x').insert(1, 'b');
    const frame = (u: Uint8Array) =>
      new OutgoingMessage('room').createSyncMessage().writeUpdate(u).toUint8Array();
    const metrics = new QueueMetrics();
    metrics.receive(frame(updates[0]!));
    expect(metrics.pending.size).toBe(0);
    metrics.start();
    metrics.receive(frame(updates[0]!));
    metrics.receive(frame(updates[1]!));
    metrics.enter(updates[0]!);
    expect(metrics.transitions.at(-1)).toMatchObject({ waiting: 1, active: 1, outstanding: 2 });
    metrics.finish(updates[0]!);
    expect(metrics.pending.size).toBe(1);
    metrics.enter(updates[1]!);
    metrics.finish(updates[1]!);
    expect(metrics.pending.size).toBe(0);
    expect(ordinaryUpdate(frame(updates[0]!))).toEqual(updates[0]);
    expect(updateReceipt(updates[0]!)).not.toBe(updateReceipt(updates[1]!));
    doc.destroy();
  });
  it('uses unfiltered nearest-rank percentiles and ignores non-update messages', () => {
    expect(distribution(Array.from({ length: 200 }, (_, i) => i + 1))).toEqual({
      p50: 100,
      p95: 190,
      p99: 198,
      max: 200,
    });
    expect(ordinaryUpdate(new Uint8Array([0]))).toBeUndefined();
    const message = new OutgoingMessage('room').writeStateless('unrelated').toUint8Array();
    expect(new IncomingMessage(message).readVarString()).toBe('room');
    expect(ordinaryUpdate(message)).toBeUndefined();
  });
});
