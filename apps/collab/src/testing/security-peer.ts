import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
/** Real wire client, with no retry hiding the first server-side disconnection. */
export function securityPeer(url: string, name: string, cookie: string, origin: string) {
  let closed = false,
    failed = false;
  const doc = new Y.Doc();
  const socket = new HocuspocusProviderWebsocket({
    url,
    autoConnect: false,
    maxAttempts: 1,
    WebSocketPolyfill: class extends WebSocket {
      constructor(address: string) {
        super(address, { headers: { cookie, origin } });
      }
    },
  });
  const provider = new HocuspocusProvider({
    name,
    document: doc,
    websocketProvider: socket,
    awareness: null,
    token: '',
    onClose: () => {
      closed = true;
    },
    onAuthenticationFailed: () => {
      failed = true;
    },
  });
  provider.attach();
  void socket.connect();
  return {
    provider,
    doc,
    get closed() {
      return closed;
    },
    get failed() {
      return failed;
    },
    destroy() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}
