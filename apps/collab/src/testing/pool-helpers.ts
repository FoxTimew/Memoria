import { randomUUID } from 'node:crypto';
import { setTimeout as delay } from 'node:timers/promises';
import * as Y from 'yjs';
import WebSocket from 'ws';
import { HocuspocusProvider, HocuspocusProviderWebsocket } from '@hocuspocus/provider';
import type { TestDatabase } from './database.ts';
import { decodeDocument } from '../codec.ts';
export async function until(
  check: () => boolean | Promise<boolean>,
  label: string,
  timeout = 15000,
) {
  const end = Date.now() + timeout;
  while (!(await check())) {
    if (Date.now() > end) throw new Error(`Timeout: ${label}`);
    await delay(20);
  }
}
export const firstText = (doc: Y.Doc) =>
  [...doc.getXmlFragment('prosemirror').createTreeWalker(() => true)].find(
    (node): node is Y.XmlText => node instanceof Y.XmlText,
  )!;
export async function seedPage(db: TestDatabase, source: Uint8Array) {
  const doc = new Y.Doc();
  doc.getXmlFragment('prosemirror');
  Y.applyUpdate(doc, source);
  doc.transact(() => {
    for (const node of doc.getXmlFragment('prosemirror').createTreeWalker(() => true))
      if (node instanceof Y.XmlElement && node.nodeName === 'blockContainer')
        node.setAttribute('id', randomUUID());
  });
  const snapshot = Y.encodeStateAsUpdate(doc),
    business = Buffer.byteLength(JSON.stringify(decodeDocument(doc))),
    page = randomUUID(),
    generation = randomUUID();
  doc.destroy();
  await db.pool.query('INSERT INTO pages(id,workspace_id,position) VALUES($1,$2,$3)', [
    page,
    db.workspace,
    page.replaceAll('-', ''),
  ]);
  await db.pool.query(
    'INSERT INTO collaboration_documents(page_id,workspace_id,generation,snapshot,encoded_bytes,business_bytes) VALUES($1,$2,$3,$4,$5,$6)',
    [page, db.workspace, generation, Buffer.from(snapshot), snapshot.length, business],
  );
  return {
    page,
    generation,
    name: `${db.workspace}:${page}:${generation}`,
    bytes: snapshot.length,
    business,
  };
}
export function peer(url: string, name: string, cookie: string, doc = new Y.Doc()) {
  const socket = new HocuspocusProviderWebsocket({
    url,
    autoConnect: false,
    maxAttempts: 1,
    WebSocketPolyfill: class extends WebSocket {
      constructor(url: string) {
        super(url, { headers: { cookie, origin: 'https://localhost' } });
      }
    },
  });
  let closed = false;
  const receipts: { revision: number; kind?: string }[] = [];
  const provider = new HocuspocusProvider({
    name,
    document: doc,
    websocketProvider: socket,
    awareness: null,
    // Same keepalive as the frontend, including providers without awareness.
    forceSyncInterval: 15000,
    token: '',
    onStateless: ({ payload }) => {
      const value = JSON.parse(payload);
      if (value.kind !== 'sync') receipts.push(value);
    },
    onClose: () => {
      closed = true;
      socket.disconnect();
    },
    onAuthenticationFailed: () => {
      closed = true;
      socket.disconnect();
    },
  });
  provider.attach();
  void socket.connect();
  return {
    doc,
    provider,
    socket,
    receipts,
    get closed() {
      return closed;
    },
    destroy() {
      provider.destroy();
      socket.destroy();
      doc.destroy();
    },
  };
}
