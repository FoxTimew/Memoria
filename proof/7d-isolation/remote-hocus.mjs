import { Worker } from 'node:worker_threads';
import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import { OutgoingMessage } from '@hocuspocus/server';
import { Rpc } from './rpc.mjs';

class RemoteDocument {
  constructor(owner, name) {
    this.owner = owner;
    this.name = name;
    this.epoch = owner.epoch;
    this.awareness = { owner, name };
  }
  call(method, ...args) {
    if (this.owner.epoch !== this.epoch) return Promise.reject(Error('PUBLICATION_DOCUMENT_STALE'));
    return this.owner.rpc.call(method, this.name, ...args);
  }
  getXmlFragment() {
    /* Initialization happens in the worker immediately before apply. */
  }
  apply(bytes) {
    return this.call('apply', bytes);
  }
  load(snapshot, updates) {
    return this.call('load', snapshot, updates);
  }
  containsUpdate(bytes) {
    return this.call('contains', bytes);
  }
  snapshot() {
    return this.call('snapshot');
  }
  destroy() {
    void this.call('destroy').catch(() => {});
  }
}
export const applyRemote = (doc, bytes) => doc.apply(bytes);
export function removeAwarenessStates(awareness, ids) {
  void awareness.owner.rpc.call('removePresence', awareness.name, ids).catch(() => {});
}

// Only used by the proof bundle. The installed Hocuspocus package is not patched.
export class Hocuspocus {
  documents = new Map();
  clients = new Map();
  connections = new Map();
  frames = new Map();
  nextFrame = 0;
  epoch = 0;
  restarting = false;
  stopped = false;
  onFailure = async () => {};
  debouncer = { executeNow: (name) => this.rpc.call('flush', name) };
  constructor(config) {
    this.config = config;
    this.ready = this.start();
  }
  async start() {
    const epoch = ++this.epoch;
    const worker = (this.worker = new Worker(
      new URL('./proof-publication-worker.mjs', import.meta.url),
      {
        resourceLimits: { maxOldGenerationSizeMb: 384, maxYoungGenerationSizeMb: 16 },
      },
    ));
    this.rpc = new Rpc(worker, {
      hook: (name, payload) => this.hook(name, payload, epoch),
      send: (id, data) => {
        if (epoch === this.epoch) this.clients.get(id)?.socket.send(data);
      },
      closeSocket: (id, code, reason) => {
        if (epoch === this.epoch) this.clients.get(id)?.socket.close(code, reason);
      },
    });
    let failed = false;
    const lost = () => {
      if (failed || this.stopped || epoch !== this.epoch) return;
      failed = true;
      this.restarting = true;
      this.rpc.stop();
      for (const c of this.clients.values()) c.socket.close(1011, 'ROOM_RELOAD_REQUIRED');
      this.documents.clear();
      void (async () => {
        await worker.terminate();
        for (const c of this.connections.values())
          await this.config.onDisconnect?.({ socketId: c.socketId, context: c.context });
        await this.onFailure();
        this.frames.clear();
        this.clients.clear();
        this.connections.clear();
        if (!this.stopped) {
          await this.start();
          this.restarting = false;
        }
      })().catch(() => {
        this.restarting = true;
      });
    };
    worker.on('error', lost);
    worker.on('exit', lost);
    const options = Object.fromEntries(
      Object.entries(this.config).filter(([, v]) => typeof v !== 'function'),
    );
    await this.rpc.call('initialize', options);
  }
  document(name) {
    if (!name) return undefined;
    if (!this.documents.has(name)) this.documents.set(name, new RemoteDocument(this, name));
    return this.documents.get(name);
  }
  async hook(name, p, epoch) {
    if (epoch !== this.epoch || this.restarting) throw Error('PUBLICATION_WORKER_LOST');
    const client = this.clients.get(p.bridgeId);
    let connection;
    if (p.connection) {
      const c = p.connection;
      connection = this.connections.get(c.socketId);
      if (!connection) {
        if (!client) throw Error('PUBLICATION_CLIENT_MISSING');
        connection = {
          ...c,
          context: client.context,
          document: this.document(c.document),
          // Send receipts on the real socket: the trace clocks still mark actual emission.
          sendStateless: (payload) =>
            client.socket.send(
              new OutgoingMessage(c.messageAddress).writeStateless(payload).toUint8Array(),
            ),
        };
        this.connections.set(c.socketId, connection);
      }
      connection.readOnly = c.readOnly;
    }
    const raw = p.updateId === undefined ? undefined : this.frames.get(p.updateId);
    const payload = {
      ...p,
      context: client?.context,
      document: this.document(p.document),
      connection,
      update: raw,
    };
    if (name === 'afterHandleMessage' && !raw) throw Error('PUBLICATION_FRAME_IDENTITY_MISSING');
    let result;
    try {
      result = await this.config[name]?.(payload);
    } catch (error) {
      if (name === 'onLoadDocument') this.documents.delete(p.document);
      throw error;
    }
    if (name === 'onAuthenticate' && result && client) Object.assign(client.context, result);
    if (name === 'afterHandleMessage') {
      this.frames.delete(p.updateId);
      client?.frames.delete(p.updateId);
    }
    if (name === 'onDisconnect') this.connections.delete(p.socketId);
    return { result, connectionConfig: payload.connectionConfig, states: payload.states };
  }
  handleConnection(socket, request, context) {
    if (this.restarting || this.stopped) throw Error('SERVICE_UNAVAILABLE');
    const id = randomUUID(),
      entry = { socket, context, frames: new Set() };
    this.clients.set(id, entry);
    const active = this.rpc,
      epoch = this.epoch;
    void active
      .call('attach', id, request.url)
      .catch(() => socket.close(1011, 'SERVICE_UNAVAILABLE'));
    return {
      handleMessage: (bytes) => {
        if (epoch !== this.epoch) {
          socket.close(1011, 'ROOM_RELOAD_REQUIRED');
          return;
        }
        const frame = ++this.nextFrame;
        this.frames.set(frame, bytes);
        entry.frames.add(frame);
        void active
          .call('frame', id, frame, bytes)
          .catch(() => socket.close(1011, 'ROOM_RELOAD_REQUIRED'));
      },
      touch: () => {
        void active.call('touch', id).catch(() => {});
      },
      handleClose: () => {
        void active
          .call('close', id)
          .catch(() => {})
          .finally(() => {
            for (const frame of entry.frames) this.frames.delete(frame);
            this.clients.delete(id);
          });
      },
    };
  }
  async createDocument(name, request, id, config) {
    await this.rpc.call('create', name, request.url, id, config);
    return this.document(name);
  }
  async unloadDocument(doc) {
    if (!(await doc.call('unload'))) this.documents.delete(doc.name);
  }
  async metrics() {
    return this.rpc.call('metrics');
  }
  async stopPublication() {
    this.stopped = true;
    // Original server shutdown has already closed all physical sockets and drained rooms.
    await delay(0);
    this.rpc.stop();
    await this.worker.terminate();
  }
}
