import { parentPort } from 'node:worker_threads';
import { Hocuspocus } from '@hocuspocus/server';
import * as Y from 'yjs';
import { removeAwarenessStates } from 'y-protocols/awareness';
import { Rpc } from './rpc.mjs';

let hocus;
const clients = new Map(),
  documents = new Map(),
  frames = new WeakMap();
const hooks = [
  'onAuthenticate',
  'onLoadDocument',
  'connected',
  'onDisconnect',
  'beforeUnloadDocument',
  'beforeSync',
  'afterHandleMessage',
  'beforeHandleAwareness',
];
const rpc = new Rpc(parentPort, {
  initialize(options) {
    hocus = new Hocuspocus({
      ...options,
      ...Object.fromEntries(
        hooks.map((name) => [
          name,
          async (payload) => {
            if (payload.document) documents.set(payload.document.name, payload.document);
            const connection = payload.connection;
            const value = {
              socketId: payload.socketId,
              documentName: payload.documentName,
              bridgeId: payload.context?.bridgeId ?? connection?.context.bridgeId,
              document: payload.document?.name,
              token: payload.token,
              connectionConfig: payload.connectionConfig,
              type: payload.type,
              payload: payload.payload,
              updateId: payload.update && frames.get(payload.update),
              states: payload.states,
              removedClients: payload.removedClients,
              connection: connection && {
                socketId: connection.socketId,
                readOnly: connection.readOnly,
                document: connection.document.name,
                messageAddress: connection.messageAddress,
                bridgeId: connection.context.bridgeId,
              },
            };
            const answer = await rpc.call('hook', name, value);
            if (payload.connectionConfig && answer.connectionConfig)
              Object.assign(payload.connectionConfig, answer.connectionConfig);
            if (payload.states && answer.states) {
              payload.states.clear();
              for (const [id, state] of answer.states) payload.states.set(id, state);
            }
            if (name === 'onAuthenticate' && answer.result)
              Object.assign(payload.context, answer.result);
            return answer.result;
          },
        ]),
      ),
    });
  },
  attach(id, url) {
    const entry = { readyState: 1 };
    entry.client = hocus.handleConnection(
      {
        get readyState() {
          return entry.readyState;
        },
        send(data) {
          void rpc.call('send', id, data).catch(() => {});
        },
        close(code, reason) {
          void rpc.call('closeSocket', id, code, reason).catch(() => {});
        },
      },
      new globalThis.Request(url),
      { bridgeId: id },
    );
    clients.set(id, entry);
  },
  frame(id, frameId, bytes) {
    frames.set(bytes, frameId);
    clients.get(id)?.client.handleMessage(bytes);
  },
  touch(id) {
    clients.get(id)?.client.touch();
  },
  async close(id) {
    const entry = clients.get(id);
    if (entry) {
      entry.readyState = 3;
      await entry.client.handleClose();
      clients.delete(id);
    }
  },
  apply(name, bytes) {
    const doc = documents.get(name);
    if (!doc) throw Error('PUBLICATION_DOCUMENT_MISSING');
    doc.getXmlFragment('prosemirror');
    Y.applyUpdate(doc, bytes);
  },
  load(name, snapshot, updates) {
    const doc = documents.get(name);
    if (!doc) throw Error('PUBLICATION_DOCUMENT_MISSING');
    doc.getXmlFragment('prosemirror');
    Y.applyUpdate(doc, updates.length ? Y.mergeUpdates([snapshot, ...updates]) : snapshot);
  },
  contains(name, bytes) {
    const doc = documents.get(name);
    if (!doc) throw Error('PUBLICATION_DOCUMENT_MISSING');
    return Y.snapshotContainsUpdate(Y.snapshot(doc), bytes);
  },
  snapshot(name) {
    const doc = documents.get(name);
    if (!doc) throw Error('PUBLICATION_DOCUMENT_MISSING');
    return Y.encodeStateAsUpdate(doc);
  },
  removePresence(name, ids) {
    const doc = documents.get(name);
    if (doc) removeAwarenessStates(doc.awareness, ids, null);
  },
  async create(name, url, id, config) {
    await hocus.createDocument(name, new globalThis.Request(url), id, config);
  },
  async flush(name) {
    await hocus.debouncer.executeNow(name);
  },
  async unload(name) {
    const doc = documents.get(name);
    if (doc) {
      await hocus.unloadDocument(doc);
      if (!hocus.documents.has(name)) documents.delete(name);
    }
    return hocus.documents.has(name);
  },
  destroy(name) {
    documents.get(name)?.destroy();
    documents.delete(name);
  },
  metrics() {
    return { memory: process.memoryUsage(), documents: documents.size };
  },
});
