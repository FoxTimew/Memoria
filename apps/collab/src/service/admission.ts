import type { CollabConfig } from './config.ts';
import { envelope } from './protocol.ts';
export interface SocketBudget {
  user: string;
  address?: string;
  room?: string;
  ready: boolean;
  closed: boolean;
  pending: Map<Uint8Array, number>;
  handshakeCount: number;
  handshakeBytes: number;
}
interface Bucket {
  tokens: number;
  at: number;
  sockets: number;
}
/** Every frame is charged synchronously BEFORE Hocuspocus.handleMessage, including native queues. */
export class Admission {
  private pendingAuth = 0;
  private authenticated = 0;
  private bytes = 0;
  private users = new Map<string, Bucket>();
  private rooms = new Map<string, { bytes: number; messages: number }>();
  constructor(
    private readonly config: CollabConfig,
    private readonly now = () => performance.now(),
  ) {}
  beginAuthentication() {
    if (this.pendingAuth >= this.config.COLLAB_MAX_UNAUTHENTICATED)
      throw new Error('AUTH_CAPACITY');
    this.pendingAuth++;
    let done = false;
    return () => {
      if (!done) {
        done = true;
        this.pendingAuth--;
      }
    };
  }
  open(user: string): SocketBudget {
    const bucket = this.users.get(user) ?? {
      tokens: this.config.COLLAB_UPDATE_BURST,
      at: this.now(),
      sockets: 0,
    };
    if (
      this.authenticated >= this.config.COLLAB_MAX_SOCKETS ||
      bucket.sockets >= this.config.COLLAB_MAX_USER_SOCKETS
    )
      throw new Error('SOCKET_CAPACITY');
    this.authenticated++;
    bucket.sockets++;
    this.users.set(user, bucket);
    return {
      user,
      ready: false,
      closed: false,
      pending: new Map(),
      handshakeCount: 0,
      handshakeBytes: 0,
    };
  }
  receive(socket: SocketBudget, bytes: Uint8Array) {
    if (socket.closed) throw new Error('SOCKET_CLOSED');
    const user = this.users.get(socket.user)!;
    const now = this.now();
    user.tokens = Math.min(
      this.config.COLLAB_UPDATE_BURST,
      user.tokens + ((now - user.at) / 1000) * this.config.COLLAB_UPDATES_PER_SECOND,
    );
    user.at = now;
    // Count every message: a flood of control/handshake frames must not bypass rate limits.
    if (user.tokens < 1) throw new Error('MESSAGE_RATE_LIMIT');
    user.tokens--;
    if (bytes.length === 1 && bytes[0] === 10) {
      if (!socket.ready) throw new Error('AUTH_REQUIRED');
      return { type: 10 };
    }
    const parsed = envelope(bytes);
    if (socket.address && socket.address !== parsed.address)
      throw new Error('MULTIPLEXING_DISABLED');
    socket.address = parsed.address;
    socket.room = parsed.name;
    if (
      !socket.ready &&
      (++socket.handshakeCount > 8 || (socket.handshakeBytes += bytes.length) > 32768)
    )
      throw new Error('HANDSHAKE_QUEUE_FULL');
    if (parsed.type === 2) {
      if (socket.ready) throw new Error('AUTH_REPLAY_DISABLED');
      return parsed;
    }
    const room = this.rooms.get(parsed.name) ?? { bytes: 0, messages: 0 };
    if (
      room.messages >= this.config.COLLAB_ROOM_QUEUE_MESSAGES ||
      room.bytes + bytes.length > this.config.COLLAB_ROOM_QUEUE_BYTES ||
      this.bytes + bytes.length > this.config.COLLAB_TOTAL_QUEUE_BYTES
    )
      throw new Error('ROOM_QUEUE_FULL');
    room.bytes += bytes.length;
    room.messages++;
    this.bytes += bytes.length;
    this.rooms.set(parsed.name, room);
    socket.pending.set(bytes, bytes.length);
    return parsed;
  }
  finish(socket: SocketBudget, bytes: Uint8Array) {
    const size = socket.pending.get(bytes);
    if (size === undefined) return;
    socket.pending.delete(bytes);
    this.bytes -= size;
    const room = this.rooms.get(socket.room!)!;
    room.bytes -= size;
    room.messages--;
    if (!room.messages) this.rooms.delete(socket.room!);
  }
  close(socket: SocketBudget) {
    if (socket.closed) return;
    socket.closed = true;
    for (const bytes of socket.pending.keys()) this.finish(socket, bytes);
    this.authenticated--;
    const user = this.users.get(socket.user)!;
    if (--user.sockets === 0) {
      user.at = this.now();
    }
    this.prune();
  }
  private prune() {
    const now = this.now();
    for (const [id, b] of this.users) if (!b.sockets && now - b.at >= 60000) this.users.delete(id);
  }
  get pendingBytes() {
    return this.bytes;
  }
  get sockets() {
    return this.authenticated;
  }
}
