import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import { until, firstText } from './pool-helpers.ts';
import { receiptFor } from '../service/store.ts';
/** Actual wire client: no resolver override, no injected access context. */
export async function nativeRowClient(
  url: string,
  ca: string,
  cookie: string,
  origin: string,
  room: string,
  token: unknown,
) {
  const doc = new Y.Doc();
  doc.getXmlFragment('prosemirror');
  let closed = false;
  const receipts = new Set<string>();
  const socket = new HocuspocusProviderWebsocket({
    url,
    autoConnect: false,
    maxAttempts: 1,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address: string) {
        super(address, { ca, headers: { cookie, origin } });
      }
    },
  });
  const provider = new HocuspocusProvider({
    name: room,
    document: doc,
    awareness: null,
    websocketProvider: socket,
    token: typeof token === 'string' ? token : JSON.stringify(token),
    onClose: () => {
      closed = true;
    },
    onAuthenticationFailed: () => {
      closed = true;
    },
    onStateless: ({ payload }) => {
      const r = JSON.parse(payload);
      if (r.status === 'durable') receipts.add(r.receipt);
    },
  });
  provider.attach();
  void socket.connect().catch(() => {
    closed = true;
  });
  await until(() => provider.synced || closed, 'native row admission');
  return {
    doc,
    provider,
    closed: () => closed,
    receipts,
    async edit(text: string) {
      let bytes: Uint8Array | undefined;
      const capture = (u: Uint8Array) => {
        bytes = u;
      };
      doc.once('update', capture);
      firstText(doc).insert(firstText(doc).length, text);
      if (!bytes) throw new Error('No local update');
      const receipt = receiptFor(bytes);
      await until(() => receipts.has(receipt) || closed, 'native row durable receipt');
      return receipts.has(receipt);
    },
    close() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}
