import { createServer } from 'node:http';
import type { IncomingMessage } from 'node:http';
import { once } from 'node:events';
import { WebSocketServer, WebSocket } from 'ws';
import type { CollabConfig } from './config.ts';
import { Admission } from './admission.ts';
import type { SocketBudget } from './admission.ts';
import { documentBytes } from './config.ts';
export interface VerifiedSession {
  user: string;
  session: string;
  name: string;
}
export async function createIngress(
  config: CollabConfig,
  authorize: (request: IncomingMessage) => Promise<VerifiedSession>,
  attach: (
    socket: WebSocket,
    identity: VerifiedSession,
    request: IncomingMessage,
    budget: SocketBudget,
  ) => (bytes: Uint8Array) => void,
  ready?: () => Promise<void>,
) {
  const admission = new Admission(config),
    sockets = new Set<WebSocket>();
  const http = createServer((req, res) => {
    if (req.method === 'GET' && req.url === '/api/health/collab' && ready) {
      void ready()
        .then(() => {
          res.writeHead(200, { 'content-type': 'application/json' });
          res.end('{"status":"ok"}');
        })
        .catch(() => {
          res.writeHead(503);
          res.end('unavailable');
        });
    } else {
      res.writeHead(404);
      res.end();
    }
  });
  const ws = new WebSocketServer({
    noServer: true,
    maxPayload: documentBytes + 65536,
    perMessageDeflate: false,
  });
  http.headersTimeout = 5000;
  http.requestTimeout = 5000;
  http.on('upgrade', (request, socket, head) => {
    let finishAuth: () => void;
    try {
      if (request.url !== '/collab' || request.headers.origin !== config.APP_ORIGIN)
        throw new Error('Origin');
      finishAuth = admission.beginAuthentication();
    } catch {
      socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n');
      return;
    }
    const deadline = setTimeout(() => {
      finishAuth();
      socket.destroy();
    }, 5000);
    void authorize(request)
      .then((identity) => {
        if (socket.destroyed) return;
        const budget = admission.open(identity.user);
        socket.once('close', () => admission.close(budget));
        ws.handleUpgrade(request, socket, head, (connection) => {
          sockets.add(connection);
          let handle: (bytes: Uint8Array) => void;
          const handshake = setTimeout(() => {
            if (!budget.ready) connection.close(1008, 'AUTH_TIMEOUT');
          }, 5000);
          connection.on('close', () => {
            clearTimeout(handshake);
            admission.close(budget);
            sockets.delete(connection);
          });
          connection.on('error', () => connection.close(1008, 'INVALID_FRAME'));
          try {
            handle = attach(connection, identity, request, budget);
          } catch {
            connection.close(1011, 'SERVICE_UNAVAILABLE');
            return;
          }
          connection.on('message', (data, binary) => {
            if (connection.readyState !== WebSocket.OPEN) return;
            try {
              if (!binary) throw new Error('BINARY_REQUIRED');
              const bytes = Array.isArray(data)
                ? Buffer.concat(data)
                : data instanceof ArrayBuffer
                  ? new Uint8Array(data)
                  : data;
              admission.receive(budget, bytes);
              handle(bytes);
            } catch (error) {
              connection.close(
                1008,
                error instanceof Error ? error.message.slice(0, 100) : 'REJECTED',
              );
            }
          });
        });
      })
      .catch(() => socket.end('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'))
      .finally(() => {
        clearTimeout(deadline);
        finishAuth();
      });
  });
  http.listen(config.COLLAB_PORT, config.COLLAB_HOST);
  await once(http, 'listening');
  return {
    http,
    admission,
    sockets,
    get url() {
      const address = http.address();
      if (!address || typeof address === 'string') throw new Error('Not listening');
      return `ws://${config.COLLAB_HOST}:${address.port}/collab`;
    },
    async close() {
      for (const socket of sockets) socket.terminate();
      await new Promise<void>((resolve) => ws.close(() => resolve()));
      await new Promise<void>((resolve) => http.close(() => resolve()));
    },
  };
}
