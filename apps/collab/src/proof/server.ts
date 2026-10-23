// Technical proof harness, bound to loopback only; not an application entry point.
import { createHash } from 'node:crypto';
import { Server } from '@hocuspocus/server';
import type { Connection } from '@hocuspocus/server';
import * as Y from 'yjs';
import { CandidateValidator } from '../validator.ts';
import { appendUpdate } from '../journal.ts';
import type { WriteIdentity } from '../journal.ts';
import type { ProofDatabase } from './database.ts';
import type { proofAuth } from './auth.ts';

type Context = WriteIdentity & { name: string };
export async function proofServer(
  db: ProofDatabase,
  authentication: Awaited<ReturnType<typeof proofAuth>>,
  room: string,
  initial: Uint8Array,
) {
  const validator = new CandidateValidator(new URL('./validation-worker.mjs', import.meta.url));
  await validator.ready();
  const connections = new Set<Connection<Context>>();
  const readers = new Set<string>();
  const receipts = new Map<
    Connection<Context>,
    { revision: number; receipt: string; update: Uint8Array }
  >();
  const releases = new Map<Connection<Context>, () => void>();
  let tail = Promise.resolve();
  let queued = 0;
  let rejectNextJournal = false;
  let holdNext: (() => Promise<void>) | undefined;
  let onCommitted = () => {};
  const rejected: string[] = [];
  async function authorized(identity: WriteIdentity) {
    const result = await authentication.pool.query(
      `WITH RECURSIVE ancestors AS (
      SELECT id,parent_id,deleted_at FROM pages WHERE id=$1 AND workspace_id=$2
      UNION ALL SELECT p.id,p.parent_id,p.deleted_at FROM pages p JOIN ancestors a ON p.id=a.parent_id WHERE p.workspace_id=$2
    ) SELECT 1 FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id
      JOIN workspace_members m ON m.user_id=u.id AND m.workspace_id=$2 JOIN workspaces w ON w.id=m.workspace_id
      WHERE s.id=$3 AND u.id=$4 AND s.expires_at>clock_timestamp() AND u.email_verified AND m.role IN ('owner','member') AND w.deleted_at IS NULL
      AND EXISTS (SELECT 1 FROM ancestors) AND NOT EXISTS (SELECT 1 FROM ancestors WHERE deleted_at IS NOT NULL)`,
      [identity.page, identity.workspace, identity.session, identity.user],
    );
    return result.rowCount === 1;
  }
  async function recheck() {
    for (const connection of connections) {
      if (!(await authorized(connection.context)))
        connection.webSocket.close(1008, 'Access revoked');
    }
  }
  const poll = setInterval(() => {
    void recheck().catch(() => {
      for (const c of connections) c.webSocket.close(1011, 'Control unavailable');
    });
  }, 5000);
  const server = new Server<Context>({
    address: '127.0.0.1',
    port: 0,
    quiet: true,
    stopOnSignals: false,
    websocketOptions: { maxPayload: 4 * 1024 ** 2 + 65536, perMessageDeflate: false },
    maxUnauthenticatedQueueSize: 32768,
    maxUnauthenticatedQueueMessages: 8,
    maxPendingDocuments: 1,
    async onAuthenticate({ requestHeaders, documentName, connectionConfig, request }) {
      if (
        requestHeaders.get('origin') !== authentication.origin ||
        new URL(request.url).pathname !== '/collab' ||
        documentName !== room
      )
        throw new Error('Access denied');
      const session = await authentication.auth.api.getSession({ headers: requestHeaders });
      if (!session || !session.user.emailVerified) throw new Error('Access denied');
      const identity = {
        page: db.page,
        workspace: db.workspace,
        user: session.user.id,
        session: session.session.id,
        name: session.user.name,
      };
      if (!(await authorized(identity))) throw new Error('Access denied');
      if (
        connections.size >= 500 ||
        [...connections].filter((c) => c.context.user === identity.user).length >= 20
      )
        throw new Error('Connection limit');
      connectionConfig.readOnly = readers.has(identity.user);
      return identity;
    },
    async onLoadDocument({ document }) {
      document.getXmlFragment('prosemirror');
      const stored = await authentication.pool.query<{
        snapshot: Buffer;
        snapshot_revision: string;
      }>('SELECT snapshot,snapshot_revision FROM collaboration_documents WHERE page_id=$1', [
        db.page,
      ]);
      Y.applyUpdate(document, stored.rows[0]?.snapshot ?? initial);
      const rows = await authentication.pool.query<{ update: Buffer }>(
        'SELECT update FROM collaboration_updates WHERE page_id=$1 AND revision>$2 ORDER BY revision',
        [db.page, stored.rows[0]?.snapshot_revision ?? 0],
      );
      for (const row of rows.rows) Y.applyUpdate(document, row.update);
    },
    async connected({ connection }) {
      connections.add(connection);
    },
    async onDisconnect({ socketId }) {
      for (const c of connections) if (c.socketId === socketId) connections.delete(c);
    },
    async beforeHandleMessage({ connection }) {
      if (++queued > 100) {
        queued--;
        throw new Error('Room queue full');
      }
      const previous = tail;
      tail = new Promise<void>((resolve) => {
        releases.set(connection, resolve);
      });
      await previous;
    },
    async beforeSync({ connection, context, document, type, payload }) {
      if (type === 0) return;
      try {
        if (!(await authorized(context))) throw new Error('Access denied');
        if (Y.snapshotContainsUpdate(Y.snapshot(document), payload)) return;
        if (connection.readOnly) throw new Error('Read only');
        const validated = await validator.validate(Y.encodeStateAsUpdate(document), payload);
        const hold = holdNext;
        holdNext = undefined;
        if (hold) await hold();
        if (rejectNextJournal) {
          rejectNextJournal = false;
          await db.client.query("SET memoria.proof_fail_journal TO 'on'");
        }
        const hex = createHash('sha256').update(payload).digest('hex');
        const receipt = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20, 32)}`;
        let revision: number;
        try {
          revision = await appendUpdate(db.client, context, receipt, payload, validated.blocks);
        } finally {
          await db.client.query("SET memoria.proof_fail_journal TO 'off'");
        }
        receipts.set(connection, { revision, receipt, update: payload });
      } catch (error) {
        rejected.push(error instanceof Error ? error.message : 'Rejected');
        connection.webSocket.close(1008, 'Update rejected');
        throw error;
      }
    },
    async afterHandleMessage({ connection, document }) {
      try {
        const durable = receipts.get(connection);
        if (durable) {
          if (!Y.snapshotContainsUpdate(Y.snapshot(document), durable.update))
            throw new Error('Committed update not applied');
          connection.sendStateless(
            JSON.stringify({
              status: 'durable',
              revision: durable.revision,
              receipt: durable.receipt,
            }),
          );
          onCommitted();
          receipts.delete(connection);
        }
      } finally {
        releases.get(connection)?.();
        releases.delete(connection);
        queued--;
      }
    },
    // Presence is excluded from this transport proof; reject instead of trusting supplied names.
    async beforeHandleAwareness() {
      throw new Error('Awareness disabled in proof');
    },
  });
  await server.listen();
  return {
    server,
    readers,
    connections,
    rejected,
    recheck,
    setOnCommitted(callback: () => void) {
      onCommitted = callback;
    },
    failNextJournal() {
      rejectNextJournal = true;
    },
    holdNextUpdate(callback: () => Promise<void>) {
      holdNext = callback;
    },
    async close() {
      clearInterval(poll);
      for (const c of connections) c.webSocket.close(1001, 'Proof ended');
      await server.destroy();
      await validator.close();
    },
  };
}
