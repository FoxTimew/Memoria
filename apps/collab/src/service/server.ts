import { randomUUID } from 'node:crypto';
import { fromNodeHeaders } from 'better-auth/node';
import type { Pool } from 'pg';
import type { IncomingMessage } from 'node:http';
import { Hocuspocus } from '@hocuspocus/server';
import type { Connection } from '@hocuspocus/server';
import type WebSocket from 'ws';
import * as Y from 'yjs';
import type { CollaborationCommand } from '@memoria/contracts';
import type { Auth } from '@memoria/auth';
import { Leadership } from './leadership.ts';
import { Store } from './store.ts';
import type { AccessResolver } from './store.ts';
import type { AccessRequest } from './access.ts';
import { Revocations } from './revocations.ts';
import { Room } from './room.ts';
import type { Receipt } from './room.ts';
import { Projections } from './projection.ts';
import { createIngress } from './ingress.ts';
import type { VerifiedSession } from './ingress.ts';
import type { SocketBudget } from './admission.ts';
import { roomIdentity } from './protocol.ts';
import { createInternalServer, CollaborationError } from './internal-server.ts';
import { RejectionBudget } from './rejection-budget.ts';
import { CandidateRejected } from '../validator.ts';
import type { CollabConfig } from './config.ts';
type Context = VerifiedSession & {
  socket: WebSocket;
  budget: SocketBudget;
  identity: AccessRequest;
};
export function sessionVerifier(auth: Auth) {
  return async (request: IncomingMessage): Promise<VerifiedSession> => {
    const identity = await auth.api.getSession({ headers: fromNodeHeaders(request.headers) });
    if (!identity?.user.emailVerified) throw new Error('SESSION_REQUIRED');
    return { user: identity.user.id, session: identity.session.id, name: identity.user.name };
  };
}
export async function collaborationServer(
  config: CollabConfig,
  pool: Pool,
  authorize: (request: IncomingMessage) => Promise<VerifiedSession>,
  options: { access?: AccessResolver; report?: (event: object) => void } = {},
) {
  let available = true;
  const connections = new Set<Connection<Context>>(),
    rooms = new Map<string, Room>();
  const refusals = new RejectionBudget(),
    receipts = new WeakMap<Connection<Context>, Receipt>();
  const fail = () => {
    available = false;
    for (const c of connections) c.context.socket.close(1011, 'CONTROL_UNAVAILABLE');
  };
  const leadership = new Leadership(config.DATABASE_URL, fail);
  await leadership.start();
  const store = new Store(pool, leadership, options.access),
    projections = new Projections(store, options.report);
  const assertAvailable = () => {
    if (!available) throw new CollaborationError('SERVICE_UNAVAILABLE', 503);
    void leadership.fence;
  };
  const hocus = new Hocuspocus<Context>({
    quiet: true,
    maxUnauthenticatedQueueSize: 32768,
    maxUnauthenticatedQueueMessages: 8,
    maxPendingDocuments: 1,
    async onAuthenticate({ context, documentName, connectionConfig }) {
      assertAvailable();
      if (refusals.blocked(context.user)) throw new Error('REJECTION_LIMIT');
      const identity = {
        ...roomIdentity(documentName),
        user: context.user,
        session: context.session,
        key: randomUUID(),
      };
      const access = await store.authorize(identity);
      connectionConfig.readOnly = access.level === 'read';
      const row = (
        await pool.query('SELECT generation FROM collaboration_documents WHERE page_id=$1', [
          identity.page,
        ])
      ).rows[0];
      if (row?.generation !== identity.generation) throw new Error('GENERATION_CHANGED');
      return { identity };
    },
    async onLoadDocument({ document, documentName }) {
      assertAvailable();
      const identity = roomIdentity(documentName);
      const room = new Room(store, identity.page, identity.generation, document, () => {
        for (const c of connections)
          if (c.document === document) c.context.socket.close(1011, 'ROOM_RELOAD_REQUIRED');
      });
      try {
        await room.load();
        rooms.set(documentName, room);
      } catch (error) {
        await room.close();
        throw error;
      }
    },
    async connected({ connection }) {
      connections.add(connection);
      connection.context.budget.ready = true;
    },
    async onDisconnect({ socketId }) {
      for (const c of connections)
        if (c.socketId === socketId) {
          connections.delete(c);
          c.context.socket.close(1000, 'DOCUMENT_CLOSED');
        }
    },
    async beforeUnloadDocument() {
      throw new Error('RESIDENT_REPLICA');
    },
    async beforeSync({ connection, context, document, documentName, type, payload }) {
      assertAvailable();
      if (type === 0) return;
      try {
        await store.authorize(context.identity);
        if (type === 1 && Y.snapshotContainsUpdate(Y.snapshot(document), payload)) return;
        if (connection.readOnly) throw new CollaborationError('READ_ONLY', 403);
        const receipt = await rooms.get(documentName)!.update(context.identity, payload);
        receipts.set(connection, receipt);
      } catch (error) {
        if (error instanceof CandidateRejected || error instanceof CollaborationError)
          refusals.reject(context.user);
        context.socket.close(
          1008,
          error instanceof Error ? error.message.slice(0, 100) : 'UPDATE_REJECTED',
        );
        throw error;
      }
    },
    async afterHandleMessage({ connection, update }) {
      const receipt = receipts.get(connection);
      if (receipt) {
        connection.sendStateless(JSON.stringify(receipt));
        receipts.delete(connection);
      }
      ingress.admission.finish(connection.context.budget, update);
    },
    async beforeHandleAwareness() {
      throw new Error('PRESENCE_NOT_ENABLED');
    },
  });
  const revocations = new Revocations(
    config.DATABASE_URL,
    async () => {
      const list = [...connections],
        access = await store.access(
          pool,
          list.map((c) => c.context.identity),
        );
      for (const connection of list) {
        const current = access.get(connection.context.identity.key);
        if (!current || (current.level === 'read') !== connection.readOnly)
          connection.context.socket.close(1008, 'ACCESS_REVOKED');
      }
    },
    fail,
  );
  let ingress: Awaited<ReturnType<typeof createIngress>>;
  let internal: Awaited<ReturnType<typeof createInternalServer>>;
  async function command(command: CollaborationCommand) {
    assertAvailable();
    const identity = { key: randomUUID(), ...command };
    const state = await store.open(identity);
    if (command.action === 'open')
      return {
        generation: state.generation,
        contentRevision: Number(state.content_revision),
        projectionRevision: Number(state.projection_revision),
        room: `${command.workspace}:${command.page}:${state.generation}`,
      };
    if (command.generation !== state.generation) throw new CollaborationError('GENERATION_CHANGED');
    const name = `${command.workspace}:${command.page}:${command.generation}`;
    await hocus.createDocument(
      name,
      new Request(`${config.APP_ORIGIN}/internal/collaboration`),
      randomUUID(),
      { readOnly: false, isAuthenticated: true },
    );
    const receipt = await rooms.get(name)!.command(identity, command);
    await projections.wait(command.page, command.generation, receipt.revision, receipt.receipt);
    return { ...receipt, contentRevision: receipt.revision, projectionRevision: receipt.revision };
  }
  try {
    await revocations.start();
    ingress = await createIngress(
      config,
      async (request) => {
        assertAvailable();
        return authorize(request);
      },
      (socket, identity, request, budget) => {
        const context = { ...identity, socket, budget } as Context;
        const client = hocus.handleConnection(
          {
            get readyState() {
              return socket.readyState;
            },
            send(data) {
              if (socket.bufferedAmount > 2 * 1024 ** 2) {
                socket.close(1013, 'SLOW_READER');
                return;
              }
              socket.send(data);
            },
            close(code, reason) {
              socket.close(code, reason);
            },
          },
          new Request(`${config.APP_ORIGIN}/collab`, { headers: fromNodeHeaders(request.headers) }),
          context,
        );
        socket.once('close', () => client.handleClose());
        socket.on('pong', () => client.touch());
        return (bytes) => {
          if (bytes.length === 1 && bytes[0] === 10) client.touch();
          else client.handleMessage(bytes);
        };
      },
    );
    internal = await createInternalServer(config, pool, command);
    projections.start();
  } catch (error) {
    await revocations.close();
    await leadership.close();
    throw error;
  }
  return {
    store,
    leadership,
    projections,
    rooms,
    hocus,
    connections,
    ingress,
    internal,
    command,
    refusals,
    async close() {
      available = false;
      await ingress.close();
      await internal.close();
      await revocations.close();
      await projections.close();
      for (const room of rooms.values()) {
        while (room.pending) await new Promise((r) => setTimeout(r, 10));
        await room.close();
        room.doc.destroy();
      }
      rooms.clear();
      await leadership.close();
    },
  };
}
