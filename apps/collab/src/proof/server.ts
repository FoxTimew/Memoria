// Technical proof harness, bound to loopback only; not an application entry point.
import { createHash } from 'node:crypto';
import { Server } from '@hocuspocus/server';
import type { Connection } from '@hocuspocus/server';
import * as Y from 'yjs';
import { CandidateValidator, CandidateRejected } from '../validator.ts';
import { appendUpdate } from '../journal.ts';
import type { WriteIdentity } from '../journal.ts';
import type { ProofDatabase } from './database.ts';
import type { proofAuth } from './auth.ts';
import type WebSocket from 'ws';
import { QueueMetrics, ordinaryUpdate } from './metrics.ts';
import { updateReceipt } from './metrics.ts';
import { RoomBatchQueue } from './room-batch-queue.ts';
import { appendBatch } from './batch-journal.ts';
import type { Document } from '@hocuspocus/server';

import { IncrementalValidator } from './incremental-validator.ts';
import { RejectionBudget } from './rejection-budget.ts';

type Context = WriteIdentity & { name: string };
export async function proofServer(
  db: ProofDatabase,
  authentication: Awaited<ReturnType<typeof proofAuth>>,
  room: string,
  initial: Uint8Array,
  options: { measure?: boolean; batching?: boolean; incremental?: boolean } = {},
) {
  const batching = options.batching ?? true;
  const metrics = new QueueMetrics();
  let incremental: IncrementalValidator | undefined;
  let fatal = false;
  const refusalBudget = new RejectionBudget();
  const charged = new WeakSet<Connection<Context>>();
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
  const batchSizes: number[] = [];
  type Entry = { connection: Connection<Context>; document: Document; payload: Uint8Array };
  type Receipt = { revision: number; receipt: string; update: Uint8Array };
  const recoverable = (error: unknown) =>
    error instanceof CandidateRejected ||
    (error instanceof Error &&
      ['Access denied', 'File access denied', 'Read only'].includes(error.message));
  async function attempt(entries: Entry[]): Promise<Receipt[]> {
    if (fatal) throw new Error('Room requires durable reload');
    const document = entries[0]!.document;
    for (const entry of entries) {
      if (
        entry.document !== document ||
        entry.connection.webSocket.readyState !== 1 ||
        entry.connection.readOnly ||
        refusalBudget.blocked(entry.connection.context.user) ||
        !(await authorized(entry.connection.context))
      )
        throw new Error('Access denied');
    }
    const merged = Y.mergeUpdates(entries.map((e) => e.payload));
    let committed = false;
    try {
      const validated = incremental
        ? await incremental.prepare(merged)
        : await validator.validate(Y.encodeStateAsUpdate(document), merged);
      const hold = holdNext;
      holdNext = undefined;
      if (hold) await hold();
      if (rejectNextJournal) {
        rejectNextJournal = false;
        await db.client.query("SET memoria.proof_fail_journal TO 'on'");
      }
      let revisions: Map<string, number>;
      try {
        revisions = await appendBatch(
          db.client,
          entries.map((e) => ({
            identity: e.connection.context,
            receipt: updateReceipt(e.payload),
            update: e.payload,
          })),
          merged,
          validated.blocks,
        );
        committed = true;
      } finally {
        await db.client.query("SET memoria.proof_fail_journal TO 'off'");
      }
      if (incremental) await incremental.commit();
      Y.applyUpdate(document, merged);
      batchSizes.push(entries.length);
      return entries.map((e) => ({
        revision: revisions.get(updateReceipt(e.payload))!,
        receipt: updateReceipt(e.payload),
        update: e.payload,
      }));
    } catch (error) {
      if (committed) {
        fatal = true;
        for (const c of connections) c.webSocket.close(1011, 'Durable reload required');
      } else if (incremental) await incremental.abort();
      throw error;
    }
  }
  const batches = new RoomBatchQueue<Entry, Receipt>(async (entries) => {
    for (const entry of entries) metrics.enter(entry.payload);
    try {
      return await attempt(entries);
    } catch (error) {
      if (!recoverable(error) || entries.length === 1) throw error;
      const results: (Receipt | Error)[] = [];
      // Each accepted individual advances the durable state before evaluating the next.
      for (const entry of entries) {
        try {
          results.push((await attempt([entry]))[0]!);
        } catch (individual) {
          if (!recoverable(individual)) throw individual;
          results.push(individual instanceof Error ? individual : new Error('Rejected'));
        }
      }
      return results;
    }
  });
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
      if (refusalBudget.blocked(identity.user) || !(await authorized(identity)))
        throw new Error('Access denied');
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
      if (options.incremental) {
        await incremental?.close();
        incremental = new IncrementalValidator();
        await incremental.init(Y.encodeStateAsUpdate(document));
      }
    },
    async connected({ connection }) {
      connections.add(connection);
      if (options.measure)
        (connection.webSocket as unknown as WebSocket).on('message', (data: Buffer) =>
          metrics.receive(data),
        );
    },
    async onDisconnect({ socketId }) {
      for (const c of connections) if (c.socketId === socketId) connections.delete(c);
    },
    async beforeHandleMessage({ connection }) {
      if (batching) return;
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
      if (!batching) metrics.enter(payload);
      try {
        if (refusalBudget.blocked(context.user) || !(await authorized(context)))
          throw new Error('Access denied');
        if (Y.snapshotContainsUpdate(Y.snapshot(document), payload)) return;
        if (connection.readOnly) throw new Error('Read only');
        if (batching) {
          receipts.set(connection, await batches.enqueue({ connection, document, payload }));
          return;
        }
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
        if (recoverable(error) && !charged.has(connection)) {
          charged.add(connection);
          refusalBudget.reject(context.user);
        }
        connection.webSocket.close(1008, 'Update rejected');
        throw error;
      }
    },
    async afterHandleMessage({ connection, document, update }) {
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
        const payload = ordinaryUpdate(update);
        if (payload) metrics.finish(payload);
        releases.get(connection)?.();
        releases.delete(connection);
        if (!batching) queued--;
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
    metrics,
    batchSizes,
    refusalBudget,
    get pendingBatchCount() {
      return batches.waiting;
    },
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
      await incremental?.close();
    },
  };
}
