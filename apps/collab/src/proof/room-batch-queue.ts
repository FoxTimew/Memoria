/** Serial room processor: while one batch is in flight, collect all waiting entries.
 * No debounce or timer added to a quiet room. Bound is pending entries, not socket ingress. */
export class RoomBatchQueue<T, R> {
  private pending: { value: T; resolve: (result: R) => void; reject: (error: unknown) => void }[] =
    [];
  private running = false;
  get waiting() {
    return this.pending.length;
  }
  constructor(
    private readonly process: (values: T[]) => Promise<R[]>,
    private readonly maximum = 100,
  ) {}
  enqueue(value: T): Promise<R> {
    if (this.pending.length >= this.maximum) return Promise.reject(new Error('Room queue full'));
    return new Promise((resolve, reject) => {
      this.pending.push({ value, resolve, reject });
      if (!this.running) void this.drain();
    });
  }
  private async drain() {
    this.running = true;
    while (this.pending.length) {
      const batch = this.pending.splice(0);
      try {
        const results = await this.process(batch.map((e) => e.value));
        if (results.length !== batch.length) throw new Error('Incomplete batch receipts');
        batch.forEach((e, i) => e.resolve(results[i]!));
      } catch (error) {
        for (const entry of batch) entry.reject(error);
      }
    }
    this.running = false;
  }
}
