import { setTimeout, clearTimeout } from 'node:timers';

// Private MessagePort, never exposed to the network. Bounded by original ingress admission.
export class Rpc {
  next = 0;
  pending = new Map();
  stopped = false;
  constructor(port, handlers) {
    this.port = port;
    port.on('message', async (m) => {
      if (m.rpc !== 'publication-proof') return;
      if (m.reply) {
        const waiter = this.pending.get(m.id);
        if (!waiter) return;
        this.pending.delete(m.id);
        clearTimeout(waiter.timer);
        if (m.error) waiter.reject(Object.assign(new Error(m.error.message), m.error));
        else waiter.resolve(m.value);
        return;
      }
      try {
        if (!Object.hasOwn(handlers, m.method)) throw Error('UNKNOWN_PROOF_RPC');
        const value = await handlers[m.method](...m.args);
        port.postMessage({ rpc: 'publication-proof', reply: true, id: m.id, value });
      } catch (error) {
        port.postMessage({
          rpc: 'publication-proof',
          reply: true,
          id: m.id,
          error: { name: error.name, message: error.message },
        });
      }
    });
  }
  call(method, ...args) {
    if (this.stopped) return Promise.reject(Error('PUBLICATION_UNAVAILABLE'));
    if (this.pending.size >= 4096) return Promise.reject(Error('PUBLICATION_RPC_CAPACITY'));
    const id = ++this.next;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(Error('PUBLICATION_RPC_TIMEOUT'));
      }, 30000);
      this.pending.set(id, { resolve, reject, timer });
      try {
        this.port.postMessage({ rpc: 'publication-proof', id, method, args });
      } catch (error) {
        clearTimeout(timer);
        this.pending.delete(id);
        reject(error);
      }
    });
  }
  stop() {
    this.stopped = true;
    for (const w of this.pending.values()) {
      clearTimeout(w.timer);
      w.reject(Error('PUBLICATION_WORKER_LOST'));
    }
    this.pending.clear();
  }
}
