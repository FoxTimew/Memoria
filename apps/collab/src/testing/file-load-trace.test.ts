import { expect, test } from 'vitest';
import * as encoding from 'lib0/encoding';
import { wireReceipt } from './file-load-trace.ts';
import { receiptFor } from '../service/store.ts';

test('trace reads raw ws ArrayBuffer and Buffer frames before provider processing', () => {
  const update = Uint8Array.of(1, 2, 3);
  const key = receiptFor(update);
  for (const durable of [false, true]) {
    const e = encoding.createEncoder();
    encoding.writeVarString(e, 'document');
    encoding.writeVarUint(e, durable ? 5 : 0);
    if (durable) encoding.writeVarString(e, JSON.stringify({ status: 'durable', receipt: key }));
    else {
      encoding.writeVarUint(e, 2);
      encoding.writeVarUint8Array(e, update);
    }
    const bytes = encoding.toUint8Array(e);
    expect(wireReceipt(bytes, durable)).toBe(key);
    expect(wireReceipt(Buffer.from(bytes), durable)).toBe(key);
    expect(wireReceipt(Uint8Array.from(bytes).buffer, durable)).toBe(key);
  }
  expect(wireReceipt(new ArrayBuffer(0), true)).toBeUndefined();
});
