import * as decoding from 'lib0/decoding';

/** Track application receipts, not Hocuspocus synced/unsyncedChanges counters. */
export class DurableState {
  sequence = 0;
  acknowledged = 0;
  confirmed = false;
  revision = 0;
  epoch = 0;
  private pending = new Map<string, number>();
  private chain: Promise<void> = Promise.resolve();
  constructor(
    readonly generation: string,
    private readonly changed: () => void,
  ) {}
  get dirty() {
    return this.sequence > this.acknowledged;
  }
  edit() {
    this.sequence++;
    this.changed();
  }
  reconnect() {
    this.epoch++;
    this.confirmed = false;
    this.pending.clear();
    this.changed();
  }
  sent(bytes: Uint8Array) {
    const decoder = decoding.createDecoder(bytes);
    try {
      decoding.readVarString(decoder);
      if (decoding.readVarUint(decoder) !== 0) return;
      const type = decoding.readVarUint(decoder);
      if (type !== 1 && type !== 2) return;
      const update = decoding.readVarUint8Array(decoder).slice();
      const epoch = this.epoch,
        sequence = this.sequence;
      this.chain = this.chain.then(async () => {
        const hash = [...new Uint8Array(await crypto.subtle.digest('SHA-256', update))]
          .map((v) => v.toString(16).padStart(2, '0'))
          .join('');
        const receipt = `${hash.slice(0, 8)}-${hash.slice(8, 12)}-${hash.slice(12, 16)}-${hash.slice(16, 20)}-${hash.slice(20, 32)}`;
        if (epoch === this.epoch) this.pending.set(receipt, sequence);
      });
    } catch {
      /* Authentication and heartbeat frames contain no update. */
    }
  }
  received(payload: string) {
    const epoch = this.epoch;
    this.chain = this.chain.then(() => {
      let data: unknown;
      try {
        data = JSON.parse(payload);
      } catch {
        return;
      }
      if (
        !data ||
        typeof data !== 'object' ||
        !('status' in data) ||
        data.status !== 'durable' ||
        !('generation' in data) ||
        data.generation !== this.generation ||
        !('receipt' in data) ||
        typeof data.receipt !== 'string' ||
        !('revision' in data) ||
        typeof data.revision !== 'number' ||
        !Number.isSafeInteger(data.revision) ||
        data.revision < 0 ||
        epoch !== this.epoch
      )
        return;
      const sequence = this.pending.get(data.receipt);
      if (sequence === undefined) return;
      this.acknowledged = Math.max(this.acknowledged, sequence);
      this.revision = Math.max(this.revision, data.revision);
      this.confirmed = true;
      for (const [key, value] of this.pending)
        if (value <= this.acknowledged) this.pending.delete(key);
      this.changed();
    });
  }
  async settled() {
    await this.chain;
  }
}
