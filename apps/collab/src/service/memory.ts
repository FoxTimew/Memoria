import type { Room } from './room.ts';
import { CollaborationError } from './internal-server.ts';
// 128 MiB old + 16 MiB young validator heap, 32 MiB live Yjs tree, 16 MiB buffers.
// A conservative admission reservation, not a measurement or an OS RSS hard limit.
export const replicaReservation = 192 * 1024 ** 2;
interface Entry {
  pins: number;
  idleSince: number;
  room?: Room;
  loading: boolean;
}
export class ReplicaMemory {
  private entries = new Map<string, Entry>();
  private tail: Promise<unknown> = Promise.resolve();
  private timer: ReturnType<typeof setInterval>;
  private stopped = false;
  constructor(
    readonly budget: number,
    readonly idleMs: number,
    private readonly evict: (name: string, room: Room) => Promise<void>,
  ) {
    this.timer = setInterval(
      () => {
        void this.serial(() => this.expire()).catch(() => {});
      },
      Math.min(1000, idleMs),
    );
  }
  get reservedBytes() {
    return this.entries.size * replicaReservation;
  }
  private serial<T>(work: () => Promise<T>) {
    const result = this.tail.then(work);
    this.tail = result.catch(() => {});
    return result;
  }
  private inactive(entry: Entry) {
    return !entry.loading && entry.pins === 0 && !!entry.room && entry.room.pending === 0;
  }
  private async remove(name: string, entry: Entry) {
    await this.evict(name, entry.room!);
    this.entries.delete(name);
  }
  async acquire(name: string) {
    return this.serial(async () => {
      if (this.stopped) throw new CollaborationError('SERVICE_UNAVAILABLE', 503);
      let entry = this.entries.get(name);
      if (entry?.room?.fatal) {
        if (!this.inactive(entry)) throw new CollaborationError('ROOM_RELOAD_REQUIRED', 503);
        await this.remove(name, entry);
        entry = undefined;
      }
      if (!entry) {
        while (this.reservedBytes + replicaReservation > this.budget) {
          const oldest = [...this.entries]
            .filter(([, e]) => this.inactive(e))
            .sort((a, b) => a[1].idleSince - b[1].idleSince)[0];
          if (!oldest)
            throw new CollaborationError('COLLAB_MEMORY_CAPACITY', 503, {
              message:
                'Le budget mémoire des documents actifs est atteint. Fermez un document ou réessayez plus tard.',
            });
          await this.remove(...oldest);
        }
        entry = { pins: 0, idleSince: Date.now(), loading: false };
        this.entries.set(name, entry);
      }
      entry.pins++;
      const acquired = entry;
      let released = false;
      return () => {
        if (released) return;
        released = true;
        acquired.pins--;
        if (!acquired.pins) {
          acquired.idleSince = Date.now();
          if (!acquired.loading && !acquired.room && this.entries.get(name) === acquired)
            this.entries.delete(name);
        }
      };
    });
  }
  loading(name: string) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('CONNECTION_CLOSED');
    entry.loading = true;
  }
  loaded(name: string, room: Room) {
    const entry = this.entries.get(name);
    if (!entry) throw new Error('Missing replica reservation');
    entry.room = room;
    entry.loading = false;
  }
  failed(name: string) {
    this.entries.delete(name);
  }
  private async expire() {
    if (this.stopped) return;
    for (const [name, entry] of this.entries)
      if (this.inactive(entry) && Date.now() - entry.idleSince >= this.idleMs)
        await this.remove(name, entry);
  }
  async close() {
    this.stopped = true;
    clearInterval(this.timer);
    await this.tail;
    this.entries.clear();
  }
}
