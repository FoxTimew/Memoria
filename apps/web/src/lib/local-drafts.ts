import { canonicalJson } from '@memoria/contracts';
import type { Draft, DraftSnapshot } from './legacy-draft-types.ts';

export interface LocalDraft {
  userId: string;
  pageId: string;
  token: string;
  updatedAt: number;
  snapshot: DraftSnapshot;
  editorDocument: unknown;
  invalid: boolean;
}
type LocalSession = { userId: string; sessionId: string; revoked: boolean };
const equal = (a: unknown, b: unknown) => canonicalJson(a) === canonicalJson(b);

/** Logical pending changes, never a comparison between browser and server clocks. */
export function needsRecovery(record: LocalDraft, confirmed: Draft) {
  return record.invalid || !equal(record.snapshot.draft, confirmed);
}

/** Transactions serialize writes with acknowledgements and sign-out across tabs. */
export class DraftStore {
  constructor(
    private readonly factory: () => IDBFactory = () => globalThis.indexedDB,
    private readonly name = 'memoria-local-drafts-v1',
  ) {}
  private async run<T>(work: (tx: IDBTransaction, result: (value: T) => void) => void): Promise<T> {
    const db = await new Promise<IDBDatabase>((resolve, reject) => {
      const request = this.factory().open(this.name, 1);
      request.onupgradeneeded = () => {
        for (const [name, keyPath] of [
          ['drafts', ['userId', 'pageId']],
          ['sessions', ['userId', 'sessionId']],
        ] as const) {
          const store = request.result.createObjectStore(name, { keyPath: [...keyPath] });
          store.createIndex('userId', 'userId');
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error);
      request.onblocked = () =>
        reject(new Error('Stockage local occupé. Fermez les anciens onglets.'));
    });
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(['drafts', 'sessions'], 'readwrite', { durability: 'strict' });
      let value: T;
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onabort = () => {
        db.close();
        reject(tx.error ?? new Error('Écriture locale annulée.'));
      };
      tx.onerror = () => {
        /* onabort carries the transaction failure. */
      };
      try {
        work(tx, (result) => {
          value = result;
        });
      } catch (error) {
        tx.abort();
        reject(error);
      }
    });
  }
  async open(userId: string, sessionId: string, pageId: string) {
    const record = await this.run<LocalDraft | undefined>((tx, done) => {
      const sessions = tx.objectStore('sessions');
      const request = sessions.get([userId, sessionId]);
      request.onsuccess = () => {
        const session = request.result as LocalSession | undefined;
        if (session?.revoked) {
          tx.abort();
          return;
        }
        sessions.put({ userId, sessionId, revoked: false } satisfies LocalSession);
        const draft = tx.objectStore('drafts').get([userId, pageId]);
        draft.onsuccess = () => done(draft.result as LocalDraft | undefined);
      };
    });
    return new LocalDraftHandle(this, userId, sessionId, pageId, record);
  }
  write(
    userId: string,
    sessionId: string,
    pageId: string,
    record?: LocalDraft,
    removeToken?: string,
  ) {
    return this.run<boolean>((tx, done) => {
      const allowed = tx.objectStore('sessions').get([userId, sessionId]);
      allowed.onsuccess = () => {
        if (!allowed.result || (allowed.result as LocalSession).revoked) {
          done(false);
          return;
        }
        const drafts = tx.objectStore('drafts');
        if (record) {
          drafts.put(record);
          done(true);
          return;
        }
        const current = drafts.get([userId, pageId]);
        current.onsuccess = () => {
          // An acknowledgement from tab A must never erase a newer draft from tab B.
          if ((current.result as LocalDraft | undefined)?.token === removeToken)
            drafts.delete([userId, pageId]);
          done(true);
        };
      };
    });
  }
  clearUser(userId: string, sessionId: string) {
    return this.run<void>((tx, done) => {
      const sessions = tx.objectStore('sessions');
      sessions.put({ userId, sessionId, revoked: true } satisfies LocalSession);
      const active = sessions.index('userId').openCursor(userId);
      active.onsuccess = () => {
        const cursor = active.result;
        if (!cursor) return;
        cursor.update({ ...(cursor.value as LocalSession), revoked: true });
        cursor.continue();
      };
      const drafts = tx.objectStore('drafts').index('userId').openCursor(userId);
      drafts.onsuccess = () => {
        const cursor = drafts.result;
        if (!cursor) return;
        cursor.delete();
        cursor.continue();
      };
      done();
    });
  }
}

export class LocalDraftHandle {
  private tail: Promise<unknown> = Promise.resolve();
  private token: string | undefined;
  private closed = false;
  private scheduled: string | undefined;
  constructor(
    private readonly store: DraftStore,
    private readonly userId: string,
    private readonly sessionId: string,
    private readonly pageId: string,
    readonly recovered: LocalDraft | undefined,
  ) {
    this.token = recovered?.token;
  }
  private queue(work: () => Promise<unknown>) {
    const next = this.tail.catch(() => {}).then(work);
    this.tail = next;
    return next;
  }
  sync(snapshot: DraftSnapshot, editorDocument: unknown, invalid: boolean) {
    if (this.closed) return Promise.resolve();
    const fingerprint = canonicalJson([snapshot, editorDocument, invalid]);
    if (fingerprint === this.scheduled) return this.tail;
    this.scheduled = fingerprint;
    const pending = invalid || !equal(snapshot.base, snapshot.draft);
    const token = pending ? globalThis.crypto.randomUUID() : undefined;
    const record = pending
      ? structuredClone({
          userId: this.userId,
          pageId: this.pageId,
          token: token!,
          updatedAt: Date.now(),
          snapshot,
          editorDocument,
          invalid,
        })
      : undefined;
    return this.queue(async () => {
      if (!(await this.store.write(this.userId, this.sessionId, this.pageId, record, this.token)))
        throw new Error('Cette session a été déconnectée. Le stockage local est fermé.');
      this.token = token;
    }).catch((error: unknown) => {
      if (this.scheduled === fingerprint) this.scheduled = undefined;
      throw error;
    });
  }
  discard(close = true) {
    const wasClosed = this.closed;
    this.closed = close;
    return this.queue(async () => {
      await this.store.write(this.userId, this.sessionId, this.pageId, undefined, this.token);
      this.token = undefined;
      this.scheduled = undefined;
    }).catch((error: unknown) => {
      this.closed = wasClosed;
      this.scheduled = undefined;
      throw error;
    });
  }
}

export const localDrafts = new DraftStore();
const logoutEvent = 'memoria-drafts-cleared';
export async function clearDraftsForSignOut(userId: string, sessionId: string) {
  await localDrafts.clearUser(userId, sessionId);
  globalThis.dispatchEvent(new CustomEvent(logoutEvent, { detail: userId }));
  if (typeof BroadcastChannel !== 'undefined') {
    const channel = new BroadcastChannel(logoutEvent);
    channel.postMessage(userId);
    channel.close();
  }
}
export function onDraftsCleared(userId: string, callback: () => void) {
  const local = (event: Event) => {
    if ((event as CustomEvent).detail === userId) callback();
  };
  globalThis.addEventListener(logoutEvent, local);
  const channel =
    typeof BroadcastChannel !== 'undefined' ? new BroadcastChannel(logoutEvent) : undefined;
  if (channel)
    channel.onmessage = (event: MessageEvent<unknown>) => {
      if (event.data === userId) callback();
    };
  return () => {
    globalThis.removeEventListener(logoutEvent, local);
    channel?.close();
  };
}
