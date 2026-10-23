import { createHash } from 'node:crypto';
import { IncomingMessage } from '@hocuspocus/server';

export function updateReceipt(update: Uint8Array) {
  const hex = createHash('sha256').update(update).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
}
export function ordinaryUpdate(bytes: Uint8Array) {
  try {
    const message = new IncomingMessage(bytes);
    message.readVarString();
    if (message.readVarUint() !== 0 || message.readVarUint() !== 2) return undefined;
    return message.readVarUint8Array();
  } catch {
    return undefined;
  }
}
export function distribution(samples: number[]) {
  if (!samples.length) throw new Error('No measured samples');
  const sorted = [...samples].sort((a, b) => a - b);
  const q = (p: number) => sorted[Math.ceil(p * sorted.length) - 1]!;
  return { p50: q(0.5), p95: q(0.95), p99: q(0.99), max: q(1) };
}
export class QueueMetrics {
  started = 0;
  readonly pending = new Map<string, 'waiting' | 'active'>();
  readonly transitions: { at: number; outstanding: number; waiting: number; active: number }[] = [];
  start() {
    this.pending.clear();
    this.transitions.length = 0;
    this.started = performance.now();
    this.record();
  }
  receive(bytes: Uint8Array) {
    if (!this.started) return;
    const update = ordinaryUpdate(bytes);
    if (update) {
      this.pending.set(updateReceipt(update), 'waiting');
      this.record();
    }
  }
  enter(update: Uint8Array) {
    const receipt = updateReceipt(update);
    if (this.pending.has(receipt)) {
      this.pending.set(receipt, 'active');
      this.record();
    }
  }
  finish(update: Uint8Array) {
    if (this.pending.delete(updateReceipt(update))) this.record();
  }
  private record() {
    const waiting = [...this.pending.values()].filter((state) => state === 'waiting').length;
    this.transitions.push({
      at: performance.now() - this.started,
      outstanding: this.pending.size,
      waiting,
      active: this.pending.size - waiting,
    });
  }
}
