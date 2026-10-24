import { describe, expect, it } from 'vitest';
import * as encoding from 'lib0/encoding';
import * as Y from 'yjs';
import { DurableState } from './collaboration-state.ts';
const generation = crypto.randomUUID();
function frame(update: Uint8Array, type = 2) {
  const e = encoding.createEncoder();
  encoding.writeVarString(e, 'room');
  encoding.writeVarUint(e, 0);
  encoding.writeVarUint(e, type);
  encoding.writeVarUint8Array(e, update);
  return encoding.toUint8Array(e);
}
async function receipt(update: Uint8Array, revision = 1, gen = generation) {
  const h = [...new Uint8Array(await crypto.subtle.digest('SHA-256', Uint8Array.from(update)))]
    .map((b) => b.toString(16).padStart(2, '0'))
    .join('');
  return JSON.stringify({
    status: 'durable',
    generation: gen,
    revision,
    receipt: `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`,
  });
}
describe('Durable collaboration status', () => {
  it('requires a matching server receipt, not sync status, and preserves edits made during a send', async () => {
    const state = new DurableState(generation, () => {}),
      a = new Uint8Array([1]),
      b = new Uint8Array([2]);
    state.edit();
    state.sent(frame(a));
    state.edit();
    expect(state.dirty).toBe(true);
    expect(state.confirmed).toBe(false);
    state.received(await receipt(a));
    await state.settled();
    expect(state.dirty).toBe(true);
    state.sent(frame(b));
    state.received(await receipt(b, 2));
    await state.settled();
    expect(state.dirty).toBe(false);
    expect(state.revision).toBe(2);
  });
  it('ignores unknown, malformed and foreign-generation receipts', async () => {
    const state = new DurableState(generation, () => {}),
      a = new Uint8Array([1]);
    state.edit();
    state.sent(frame(a));
    state.received('not-json');
    state.received(await receipt(a, 1, crypto.randomUUID()));
    state.received(await receipt(new Uint8Array([2])));
    await state.settled();
    expect(state.dirty).toBe(true);
    expect(state.confirmed).toBe(false);
  });
  it('reconfirms offline work with SyncStep2, ignoring late receipts from the old socket', async () => {
    const state = new DurableState(generation, () => {}),
      a = new Uint8Array([1]),
      merged = new Uint8Array([1, 2]);
    state.edit();
    state.sent(frame(a));
    state.received(await receipt(a));
    state.reconnect();
    await state.settled();
    expect(state.confirmed).toBe(false);
    state.edit();
    state.sent(frame(merged, 1));
    state.received(await receipt(merged, 3));
    await state.settled();
    expect(state.dirty).toBe(false);
    expect(state.confirmed).toBe(true);
  });
  it('confirms a delete-only update although its state vector has not changed', async () => {
    const doc = new Y.Doc(),
      state = new DurableState(generation, () => {});
    doc.getText('text').insert(0, 'hello');
    const vector = Y.encodeStateVector(doc);
    let deletion!: Uint8Array;
    doc.on('update', (u: Uint8Array) => {
      deletion = u;
    });
    doc.getText('text').delete(0, 5);
    expect(Y.encodeStateVector(doc)).toEqual(vector);
    state.edit();
    state.sent(frame(deletion));
    expect(state.dirty).toBe(true);
    state.received(await receipt(deletion));
    await state.settled();
    expect(state.dirty).toBe(false);
    doc.destroy();
  });
});
