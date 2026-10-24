import * as Y from 'yjs';

export const cacheDatabase = 'memoria-yjs-cache-v1';
export const legacyDatabase = 'memoria-local-drafts-v1';
const stores = ['users', 'sessions', 'documents', 'updates'];
const maxBytes = 8 * 1024 ** 2;
export class LocalSessionRevoked extends Error {
  constructor() {
    super('Cette session a été déconnectée sur ce poste.');
  }
}
export type CacheTicket = { user: string; session: string; epoch: number; marker: string };
export type CachePage = {
  key: string;
  user: string;
  workspace: string;
  page: string;
  generation: string;
  epoch: number;
  count: number;
  bytes: number;
  pending: string[];
};
type Session = { user: string; session: string; revoked: boolean };
type Update = { id?: number; user: string; key: string; data: Uint8Array };
export const logoutMarkerKey = (user: string) => `memoria-local-logout:${user}`;
export function logoutMarker(user: string) {
  return typeof localStorage === 'undefined'
    ? ''
    : (localStorage.getItem(logoutMarkerKey(user)) ?? '');
}

function openDatabase(
  factory: IDBFactory,
  name: string,
  version: number,
  upgrade: (db: IDBDatabase) => void,
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, version);
    let failed = false;
    request.onupgradeneeded = () => upgrade(request.result);
    request.onerror = () => reject(request.error);
    request.onblocked = () => {
      failed = true;
      reject(new Error('Stockage occupé : fermez les anciens onglets puis réessayez.'));
    };
    request.onsuccess = () => {
      if (failed) request.result.close();
      else resolve(request.result);
    };
  });
}
/** Keep a v2 tombstone: deleteDatabase would let a sleeping v1 tab recreate its drafts. */
export async function retireLegacyDrafts(factory: IDBFactory = globalThis.indexedDB) {
  const db = await openDatabase(factory, legacyDatabase, 2, (db) => {
    for (const name of Array.from(db.objectStoreNames)) db.deleteObjectStore(name);
    db.createObjectStore('retired');
  });
  db.close();
}

/** Every read, append and receipt is fenced in the SAME transaction as its content access. */
export class YjsCache {
  constructor(
    private readonly factory: () => IDBFactory = () => globalThis.indexedDB,
    private readonly marker = logoutMarker,
    private readonly name = cacheDatabase,
  ) {}
  private async run<T>(
    work: (tx: IDBTransaction, done: (value: T) => void, fail: (error: Error) => void) => void,
  ): Promise<T> {
    const db = await openDatabase(this.factory(), this.name, 1, (db) => {
      db.createObjectStore('users', { keyPath: 'user' });
      const sessions = db.createObjectStore('sessions', { keyPath: ['user', 'session'] });
      sessions.createIndex('user', 'user');
      const documents = db.createObjectStore('documents', { keyPath: 'key' });
      documents.createIndex('user', 'user');
      const updates = db.createObjectStore('updates', { keyPath: 'id', autoIncrement: true });
      updates.createIndex('key', 'key');
      updates.createIndex('user', 'user');
    });
    return new Promise<T>((resolve, reject) => {
      const tx = db.transaction(stores, 'readwrite', { durability: 'strict' });
      let value: T, failure: Error | undefined;
      const fail = (error: Error) => {
        failure = error;
        tx.abort();
      };
      tx.oncomplete = () => {
        db.close();
        resolve(value);
      };
      tx.onabort = () => {
        db.close();
        reject(failure ?? tx.error ?? new Error('Écriture locale annulée.'));
      };
      tx.onerror = () => {};
      try {
        work(
          tx,
          (v) => {
            value = v;
          },
          fail,
        );
      } catch (error) {
        fail(error as Error);
      }
    });
  }
  private allowed(
    tx: IDBTransaction,
    ticket: CacheTicket,
    next: () => void,
    fail: (e: Error) => void,
  ) {
    const user = tx.objectStore('users').get(ticket.user);
    user.onsuccess = () => {
      const session = tx.objectStore('sessions').get([ticket.user, ticket.session]);
      session.onsuccess = () => {
        try {
          if (
            !session.result ||
            (session.result as Session).revoked ||
            (user.result?.epoch ?? 0) !== ticket.epoch ||
            this.marker(ticket.user) !== ticket.marker
          ) {
            fail(new LocalSessionRevoked());
            return;
          }
          next();
        } catch (error) {
          fail(error as Error);
        }
      };
    };
  }
  /** Acquire BEFORE the HTTP access check: a delayed response cannot resurrect a signed-out session. */
  ticket(user: string, session: string) {
    const marker = this.marker(user);
    return this.run<CacheTicket>((tx, done, fail) => {
      const sessions = tx.objectStore('sessions'),
        request = sessions.get([user, session]);
      request.onsuccess = () => {
        if ((request.result as Session | undefined)?.revoked) {
          fail(new LocalSessionRevoked());
          return;
        }
        sessions.put({ user, session, revoked: false } satisfies Session);
        const epoch = tx.objectStore('users').get(user);
        epoch.onsuccess = () => done({ user, session, marker, epoch: epoch.result?.epoch ?? 0 });
      };
    });
  }
  assertActive(ticket: CacheTicket) {
    return this.run<void>((tx, done, fail) => this.allowed(tx, ticket, () => done(), fail));
  }
  open(ticket: CacheTicket, workspace: string, page: string, generation: string) {
    const key = JSON.stringify([ticket.user, workspace, page, generation]);
    return this.run<{ page: CachePage; updates: Uint8Array[]; older: CachePage[] }>(
      (tx, done, fail) => {
        this.allowed(
          tx,
          ticket,
          () => {
            const documents = tx.objectStore('documents'),
              request = documents.get(key);
            request.onsuccess = () => {
              const record: CachePage = request.result ?? {
                key,
                user: ticket.user,
                workspace,
                page,
                generation,
                epoch: 0,
                count: 0,
                bytes: 0,
                pending: [],
              };
              documents.put(record);
              const updates = tx.objectStore('updates').index('key').getAll(key);
              updates.onsuccess = () => {
                const others = documents.index('user').getAll(ticket.user);
                others.onsuccess = () =>
                  done({
                    page: record,
                    updates: (updates.result as Update[]).map((u) => u.data),
                    older: (others.result as CachePage[]).filter(
                      (p) =>
                        p.workspace === workspace &&
                        p.page === page &&
                        p.generation !== generation &&
                        p.count > 0,
                    ),
                  });
              };
            };
          },
          fail,
        );
      },
    );
  }
  private document(
    tx: IDBTransaction,
    page: CachePage,
    next: (current: CachePage) => void,
    fail: (e: Error) => void,
  ) {
    const request = tx.objectStore('documents').get(page.key);
    request.onsuccess = () => {
      const current = request.result as CachePage | undefined;
      if (!current || current.epoch !== page.epoch) {
        fail(
          new Error(
            'Le cache de cette page a été abandonné dans un autre onglet. Rechargez la page.',
          ),
        );
        return;
      }
      try {
        next(current);
      } catch (error) {
        fail(error as Error);
      }
    };
  }
  append(ticket: CacheTicket, page: CachePage, data: Uint8Array, token?: string) {
    return this.run<void>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () =>
          this.document(
            tx,
            page,
            (current) => {
              if (current.bytes + data.byteLength > maxBytes) {
                fail(
                  new Error(
                    'Le cache de cette page dépasse 8 Mio. Exportez le contenu avant de fermer.',
                  ),
                );
                return;
              }
              const updates = tx.objectStore('updates');
              updates.add({ user: ticket.user, key: page.key, data } satisfies Update);
              current.bytes += data.byteLength;
              current.count++;
              if (token) current.pending.push(token);
              const finish = () => {
                tx.objectStore('documents').put(current);
                done();
              };
              if (current.count < 64 && current.bytes < 2 * 1024 ** 2) {
                finish();
                return;
              }
              const all = updates.index('key').getAll(page.key);
              all.onsuccess = () => {
                try {
                  const records = all.result as Update[],
                    merged = Y.mergeUpdates(records.map((u) => u.data));
                  for (const record of records) updates.delete(record.id!);
                  updates.add({ user: ticket.user, key: page.key, data: merged } satisfies Update);
                  current.bytes = merged.byteLength;
                  current.count = 1;
                  finish();
                } catch (error) {
                  fail(error as Error);
                }
              };
            },
            fail,
          ),
        fail,
      ),
    );
  }
  acknowledge(ticket: CacheTicket, page: CachePage, tokens: string[]) {
    const known = new Set(tokens);
    return this.run<void>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () =>
          this.document(
            tx,
            page,
            (current) => {
              // A receipt from tab A must not erase pending work added by tab B.
              current.pending = current.pending.filter((token) => !known.has(token));
              tx.objectStore('documents').put(current);
              done();
            },
            fail,
          ),
        fail,
      ),
    );
  }
  discard(ticket: CacheTicket, page: CachePage) {
    return this.run<void>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () =>
          this.document(
            tx,
            page,
            (current) => {
              current.epoch++;
              current.pending = [];
              current.count = 0;
              current.bytes = 0;
              tx.objectStore('documents').put(current);
              this.remove(tx.objectStore('updates').index('key').openCursor(page.key));
              done();
            },
            fail,
          ),
        fail,
      ),
    );
  }
  private remove(request: IDBRequest<IDBCursorWithValue | null>) {
    request.onsuccess = () => {
      const cursor = request.result;
      if (cursor) {
        cursor.delete();
        cursor.continue();
      }
    };
  }
  clearUser(user: string, session: string) {
    return this.run<void>((tx, done) => {
      const users = tx.objectStore('users'),
        get = users.get(user);
      get.onsuccess = () => users.put({ user, epoch: (get.result?.epoch ?? 0) + 1 });
      const sessions = tx.objectStore('sessions');
      sessions.put({ user, session, revoked: true } satisfies Session);
      const known = sessions.index('user').openCursor(user);
      known.onsuccess = () => {
        const c = known.result;
        if (c) {
          c.update({ ...c.value, revoked: true });
          c.continue();
        }
      };
      this.remove(tx.objectStore('documents').index('user').openCursor(user));
      this.remove(tx.objectStore('updates').index('user').openCursor(user));
      done();
    });
  }
}
export const yjsCache = new YjsCache();
