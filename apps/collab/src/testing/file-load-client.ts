import assert from 'node:assert/strict';
import { fork } from 'node:child_process';
import { once } from 'node:events';
import * as Y from 'yjs';
import { securityPeer } from './security-peer.ts';
import { until } from './pool-helpers.ts';
import { receiptFor } from '../service/store.ts';
import { wireReceipt } from './file-load-trace.ts';

export type FileLoadClientConfig = {
  url: string;
  name: string;
  cookie: string;
  origin: string;
  ca: string;
  index: number;
  imageId: string;
  fileId: string;
  trace?: boolean;
};
type Edit = { wave: number; references: boolean };
type Reply = { id: number; result?: unknown; error?: string };
export type FileLoadReceipt = {
  wireMs: number;
  editMs: number;
  receipt: string;
  beforeSendMs?: number;
  transitMs?: number;
  receiptHandlingMs?: number;
};

/** Timers start and end in this real WSS client, never across process clocks. */
async function client(config: FileLoadClientConfig) {
  const peer = securityPeer(config.url, config.name, config.cookie, config.origin, '', config.ca);
  peer.doc.clientID = 0xefffff00 + config.index;
  await until(() => peer.provider.synced || peer.closed || peer.failed, 'file load client sync');
  assert(!peer.closed && !peer.failed, peer.reason);
  assert.equal(peer.doc.clientID, 0xefffff00 + config.index);
  const sent = new Map<string, number>(),
    received = new Map<string, number>();
  if (config.trace) {
    const send = peer.socket.send.bind(peer.socket);
    peer.socket.send = (message) => {
      if (message instanceof Uint8Array || message instanceof ArrayBuffer) {
        const key = wireReceipt(message);
        if (key) sent.set(key, performance.now());
      }
      return send(message);
    };
    (peer.socket.webSocket as unknown as import('ws').default).prependListener(
      'message',
      (data: Buffer | ArrayBuffer) => {
        const key = wireReceipt(data, true);
        if (key) received.set(key, performance.now());
      },
    );
  }
  const check = () => assert(!peer.closed && !peer.failed, peer.reason);
  return {
    check,
    async edit({ wave, references }: Edit): Promise<FileLoadReceipt> {
      check();
      const started = performance.now();
      let key = '';
      let receive!: (event: { payload: string }) => void;
      let record!: (update: Uint8Array) => void;
      let timer!: ReturnType<typeof setTimeout>;
      const confirmed = new Promise<void>((yes, no) => {
        receive = ({ payload }) => {
          const r = JSON.parse(payload);
          if (r.status === 'durable' && r.receipt === key) yes();
        };
        record = (update) => {
          key = receiptFor(update);
        };
        timer = setTimeout(
          () =>
            no(
              new Error(
                `DURABLE_RECEIPT_TIMEOUT wave=${wave} author=${config.index} closed=${peer.closed} reason=${peer.reason}`,
              ),
            ),
          5000,
        );
        peer.provider.on('stateless', receive);
        peer.doc.once('update', record);
      });
      try {
        const nodes = [...peer.doc.getXmlFragment('prosemirror').createTreeWalker(() => true)];
        if (references) {
          const container = nodes.find(
            (n) => n instanceof Y.XmlElement && n.getAttribute('id') === config.imageId,
          ) as Y.XmlElement;
          assert(container, 'Missing image container');
          const image = container.get(0) as Y.XmlElement;
          image.setAttribute('fileId', image.getAttribute('fileId') ? '' : config.fileId);
        } else {
          const text = nodes.filter((n): n is Y.XmlText => n instanceof Y.XmlText)[config.index]!;
          peer.doc.transact(() => {
            if (wave % 2) text.delete(0, 1);
            else text.insert(0, 'x');
          });
        }
        const editMs = performance.now() - started;
        assert(key, 'Each edit must emit a Yjs update');
        await confirmed;
        check();
        const finished = performance.now(),
          send = sent.get(key),
          receive = received.get(key);
        if (config.trace)
          assert(
            send !== undefined && receive !== undefined && receive >= send,
            `Client trace incomplete: send=${send !== undefined}, receive=${receive !== undefined}`,
          );
        sent.delete(key);
        received.delete(key);
        return {
          wireMs: finished - started,
          editMs,
          receipt: key,
          ...(config.trace
            ? {
                beforeSendMs: send! - started,
                transitMs: receive! - send!,
                receiptHandlingMs: finished - receive!,
              }
            : {}),
        };
      } finally {
        clearTimeout(timer);
        peer.provider.off('stateless', receive);
        peer.doc.off('update', record);
      }
    },
    close() {
      peer.destroy();
    },
  };
}

/** Client role of the same bundled entry point. No server, SQL pool or CPU sampler is started. */
export function serveFileLoadClient() {
  let peer: Awaited<ReturnType<typeof client>> | undefined;
  let busy = false;
  process.on(
    'message',
    (m: { id: number; op: string; config?: FileLoadClientConfig; edit?: Edit }) => {
      void (async () => {
        assert(!busy, 'Concurrent commands to one load client');
        busy = true;
        try {
          let result: unknown = null;
          if (m.op === 'init') {
            assert(!peer);
            peer = await client(m.config!);
            result = { pid: process.pid, clientID: 0xefffff00 + m.config!.index };
          } else if (m.op === 'edit') result = await peer!.edit(m.edit!);
          else if (m.op === 'check') peer!.check();
          else if (m.op === 'close') {
            peer?.close();
            peer = undefined;
          } else throw new Error('Unknown load client operation');
          process.send?.({ id: m.id, result });
        } finally {
          busy = false;
        }
      })().catch((error: Error) => process.send?.({ id: m.id, error: error.message }));
    },
  );
  process.on('disconnect', () => {
    peer?.close();
  });
}

export async function fileLoadClient(entry: string, config: FileLoadClientConfig) {
  const child = fork(entry, [], {
    env: { ...process.env, MEMORIA_FILES_CLIENT: 'true' },
    windowsHide: true,
    stdio: ['ignore', 'inherit', 'inherit', 'ipc'],
  });
  const pending = new Map<
    number,
    {
      yes: (value: unknown) => void;
      no: (error: Error) => void;
      timer: ReturnType<typeof setTimeout>;
    }
  >();
  let next = 0,
    closed = false;
  const rejectPending = (error: Error) => {
    for (const p of pending.values()) {
      clearTimeout(p.timer);
      p.no(error);
    }
    pending.clear();
  };
  child.on('message', (m: Reply) => {
    const p = pending.get(m.id);
    if (!p) return;
    pending.delete(m.id);
    clearTimeout(p.timer);
    if (m.error) p.no(new Error(m.error));
    else p.yes(m.result);
  });
  child.on('error', rejectPending);
  const ended = once(child, 'exit');
  child.once('exit', () => {
    closed = true;
    rejectPending(new Error('Load client exited'));
  });
  const request = (op: string, data: object = {}) =>
    new Promise<unknown>((yes, no) => {
      if (closed) return no(new Error('Load client exited'));
      const id = ++next;
      const timer = setTimeout(() => {
        pending.delete(id);
        no(new Error(`Load client command timed out: ${op}`));
        child.kill();
      }, 15000);
      pending.set(id, { yes, no, timer });
      child.send({ id, op, ...data }, (error) => {
        if (error) rejectPending(error);
      });
    });
  try {
    const ready = (await request('init', { config })) as { pid: number; clientID: number };
    assert.equal(ready.pid, child.pid);
    assert.notEqual(ready.pid, process.pid);
    assert.equal(ready.clientID, 0xefffff00 + config.index);
  } catch (error) {
    child.kill();
    await ended;
    throw error;
  }
  return {
    pid: child.pid!,
    edit: (edit: Edit) => request('edit', { edit }) as Promise<FileLoadReceipt>,
    check: () => request('check'),
    async close() {
      if (closed) return;
      try {
        await request('close');
      } finally {
        if (child.connected) child.disconnect();
        const timer = setTimeout(() => child.kill(), 5000);
        await ended;
        clearTimeout(timer);
      }
    },
  };
}
