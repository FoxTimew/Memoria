import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import WebSocket from 'ws';
import * as Y from 'yjs';
import * as encoding from 'lib0/encoding';
/** Real wire client, with no retry hiding the first server-side disconnection. */
export function securityPeer(
  url: string,
  name: string,
  cookie: string,
  origin: string,
  token = '',
) {
  let closed = false,
    failed = false;
  let closeReason = '',
    authenticationReason = '';
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
    token,
    onClose: ({ event }) => {
      closed = true;
      closeReason = event.reason;
    },
    onAuthenticationFailed: ({ reason }) => {
      failed = true;
      authenticationReason = reason;
    },
  });
  provider.attach();
  void socket.connect();
  return {
    provider,
    doc,
    sendYjs(payload: Uint8Array, type: 1 | 2 = 2) {
      const wire = encoding.createEncoder();
      encoding.writeVarString(wire, provider.effectiveName);
      encoding.writeVarUint(wire, 0);
      encoding.writeVarUint(wire, type);
      encoding.writeVarUint8Array(wire, payload);
      socket.send(encoding.toUint8Array(wire));
    },
    sendPresenceJson(json: string) {
      const payload = encoding.createEncoder();
      encoding.writeVarUint(payload, 1);
      encoding.writeVarUint(payload, doc.clientID);
      encoding.writeVarUint(payload, 1000000);
      encoding.writeVarString(payload, json);
      const wire = encoding.createEncoder();
      encoding.writeVarString(wire, provider.effectiveName);
      encoding.writeVarUint(wire, 1);
      encoding.writeVarUint8Array(wire, encoding.toUint8Array(payload));
      socket.send(encoding.toUint8Array(wire));
    },
    get closed() {
      return closed;
    },
    get failed() {
      return failed;
    },
    get reason() {
      return authenticationReason || closeReason;
    },
    destroy() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}
