import * as decoding from 'lib0/decoding';
import { receiptFor } from '../service/store.ts';
import type { Room, Receipt } from '../service/room.ts';
import type { collaborationServer } from '../service/server.ts';

/** Test-only clocks. Never infer one-way network time from different process clocks. */
export function wireReceipt(data: Uint8Array | ArrayBuffer, durable = false): string | undefined {
  try {
    const d = decoding.createDecoder(data instanceof ArrayBuffer ? new Uint8Array(data) : data);
    decoding.readVarString(d);
    const type = decoding.readVarUint(d);
    if (durable && type === 5) {
      const r = JSON.parse(decoding.readVarString(d));
      return r.status === 'durable' ? r.receipt : undefined;
    }
    if (!durable && type === 0 && [1, 2].includes(decoding.readVarUint(d)))
      return receiptFor(decoding.readVarUint8Array(d));
  } catch {
    /* Other provider messages are not measured updates. */
  }
  return undefined;
}
type Stages = Partial<
  Record<
    'ingress' | 'room' | 'batch' | 'validation' | 'sql' | 'commit' | 'applied' | 'sent',
    number
  >
>;
export function fileServerTrace(host: Awaited<ReturnType<typeof collaborationServer>>, room: Room) {
  const samples = new Map<string, Stages>();
  const mark = (key: string, stage: keyof Stages) => {
    const sample = samples.get(key) ?? {};
    sample[stage] = performance.now();
    samples.set(key, sample);
  };
  for (const c of host.connections) {
    c.context.socket.prependListener('message', (data: Buffer) => {
      const key = wireReceipt(data);
      if (key) mark(key, 'ingress');
    });
    const send = c.sendStateless.bind(c);
    c.sendStateless = (payload) => {
      const r = JSON.parse(payload);
      if (r.status === 'durable') mark(r.receipt, 'sent');
      send(payload);
    };
  }
  const update = room.update.bind(room);
  room.update = async (identity, bytes) => {
    const key = receiptFor(bytes);
    mark(key, 'room');
    const r = await update(identity, bytes);
    mark(key, 'applied');
    return r;
  };
  // Observe the real batch dispatch without changing queue behavior or adding a timer.
  const queue = room.queue as unknown as {
    process: (entries: { update?: Uint8Array }[]) => Promise<(Receipt | Error)[]>;
  };
  const process = queue.process.bind(queue);
  queue.process = (entries) => {
    for (const e of entries) if (e.update) mark(receiptFor(e.update), 'batch');
    return process(entries);
  };
  const prepare = room.replica.prepareMany.bind(room.replica);
  room.replica.prepareMany = (updates) => {
    for (const bytes of updates) mark(receiptFor(bytes), 'validation');
    return prepare(updates);
  };
  const append = host.store.append.bind(host.store);
  host.store.append = async (...args) => {
    for (const e of args[2]) mark(e.receipt, 'sql');
    const r = await append(...args);
    for (const e of args[2]) mark(e.receipt, 'commit');
    return r;
  };
  return (key: string) => {
    const s = samples.get(key);
    const names = [
      'ingress',
      'room',
      'batch',
      'validation',
      'sql',
      'commit',
      'applied',
      'sent',
    ] as const;
    if (!s || names.some((n, i) => s[n] === undefined || (i > 0 && s[n]! < s[names[i - 1]!]!)))
      throw Error('INCOMPLETE_OR_UNORDERED_WSS_TRACE');
    samples.delete(key);
    return {
      receipt: key,
      clocks: s,
      accessAndDispatchMs: s.room! - s.ingress!,
      queueMs: s.batch! - s.room!,
      reservationMs: s.validation! - s.batch!,
      validationMs: s.sql! - s.validation!,
      sqlMs: s.commit! - s.sql!,
      replicaAndApplyMs: s.applied! - s.commit!,
      diffusionAndReceiptMs: s.sent! - s.applied!,
      serverResidenceMs: s.sent! - s.ingress!,
    };
  };
}
