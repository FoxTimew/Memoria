import * as Y from 'yjs';

export const cacheDatabase = 'memoria-yjs-cache-v1';
export const legacyDatabase = 'memoria-local-drafts-v1';
const stores = ['users', 'sessions', 'documents', 'updates', 'policies'];
const maxBytes = 8 * 1024 ** 2;
export class LocalSessionRevoked extends Error {
  constructor() {
    super('Cette session a été déconnectée sur ce poste.');
  }
}
export class CacheForbidden extends Error {
  constructor() {
    super(
      'Copie locale désactivée. Les changements restent dans cet onglet jusqu’à leur enregistrement sur le serveur.',
    );
  }
}
export type CacheTicket = {
  user: string;
  session: string;
  epoch: number;
  marker: string;
  policies: Record<string, number>;
};
export type CachePolicy = {
  user: string;
  session: string;
  sharedComputer: boolean;
  workspaces: { workspace: string; version: number; allowed: boolean }[];
};
type Policy = { user: string; workspace: string; version: number; allowed: boolean; epoch: number };
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
type Session = { user: string; session: string; revoked: boolean; disabled?: boolean };
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
    const db = await openDatabase(this.factory(), this.name, 2, (db) => {
      const policies = db.createObjectStore('policies', { keyPath: ['user', 'workspace'] });
      policies.createIndex('user', 'user');
      if (db.objectStoreNames.contains('users')) return;
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
          if ((session.result as Session).disabled) {
            fail(new CacheForbidden());
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
        if (!request.result) sessions.put({ user, session, revoked: false } satisfies Session);
        const epoch = tx.objectStore('users').get(user);
        epoch.onsuccess = () =>
          done({ user, session, marker, epoch: epoch.result?.epoch ?? 0, policies: {} });
      };
    });
  }
  assertActive(ticket: CacheTicket, workspace?: string) {
    return this.run<void>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () => (workspace ? this.policyAllowed(tx, ticket, workspace, () => done(), fail) : done()),
        fail,
      ),
    );
  }
  private policyAllowed(
    tx: IDBTransaction,
    ticket: CacheTicket,
    workspace: string,
    next: () => void,
    fail: (error: Error) => void,
  ) {
    const read = tx.objectStore('policies').get([ticket.user, workspace]);
    read.onsuccess = () => {
      const policy = read.result as Policy | undefined;
      if (!policy?.allowed || ticket.policies[workspace] !== policy.epoch) {
        fail(new CacheForbidden());
        return;
      }
      next();
    };
  }
  /** Consume a fresh server decision. The pre-request ticket fences delayed HTTP responses. */
  applyPolicy(ticket: CacheTicket, snapshot: CachePolicy) {
    if (snapshot.user !== ticket.user || snapshot.session !== ticket.session)
      return Promise.reject(new LocalSessionRevoked());
    if (snapshot.sharedComputer)
      return this.disableUser(ticket).then(() => ({ ...ticket, policies: {} }));
    return this.run<CacheTicket>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () => {
          const store = tx.objectStore('policies');
          const read = store.index('user').getAll(ticket.user);
          read.onsuccess = () => {
            const known = new Map((read.result as Policy[]).map((p) => [p.workspace, p]));
            const policies: Record<string, number> = {};
            for (const proposed of snapshot.workspaces) {
              const old = known.get(proposed.workspace);
              known.delete(proposed.workspace);
              if (old && old.version > proposed.version) continue;
              const current: Policy = {
                ...proposed,
                user: ticket.user,
                epoch: (old?.epoch ?? 0) + (old && old.allowed !== proposed.allowed ? 1 : 0),
              };
              store.put(current);
              if (current.allowed) policies[current.workspace] = current.epoch;
              else this.purgeWorkspace(tx, ticket.user, current.workspace);
            }
            // Membership disappearance revokes local copies too; this is never an authorization source.
            for (const old of known.values()) {
              store.put({ ...old, allowed: false, epoch: old.epoch + (old.allowed ? 1 : 0) });
              this.purgeWorkspace(tx, ticket.user, old.workspace);
            }
            done({ ...ticket, policies });
          };
        },
        fail,
      ),
    );
  }
  private purgeWorkspace(tx: IDBTransaction, user: string, workspace: string) {
    const read = tx.objectStore('documents').index('user').openCursor(user);
    read.onsuccess = () => {
      const cursor = read.result;
      if (!cursor) return;
      const page = cursor.value as CachePage;
      if (page.workspace === workspace) {
        this.remove(tx.objectStore('updates').index('key').openCursor(page.key));
        cursor.delete();
      }
      cursor.continue();
    };
  }
  private disableUser(ticket: CacheTicket) {
    // Idempotent, including after the shared session's first purge. Never re-enable old sessions.
    return this.run<void>((tx, done, fail) => {
      const read = tx.objectStore('sessions').get([ticket.user, ticket.session]);
      read.onsuccess = () => {
        if (!read.result || read.result.revoked || this.marker(ticket.user) !== ticket.marker) {
          fail(new LocalSessionRevoked());
          return;
        }
        const cursor = tx.objectStore('sessions').index('user').openCursor(ticket.user);
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            c.update({ ...c.value, disabled: true });
            c.continue();
          }
        };
        this.remove(tx.objectStore('documents').index('user').openCursor(ticket.user));
        this.remove(tx.objectStore('updates').index('user').openCursor(ticket.user));
        done();
      };
    });
  }
  pending(user: string, workspace?: string) {
    return this.run<number>((tx, done) => {
      const read = tx.objectStore('documents').index('user').getAll(user);
      read.onsuccess = () =>
        done(
          (read.result as CachePage[]).filter(
            (p) => (!workspace || p.workspace === workspace) && p.pending.length > 0,
          ).length,
        );
    });
  }
  open(ticket: CacheTicket, workspace: string, page: string, generation: string) {
    const key = JSON.stringify([ticket.user, workspace, page, generation]);
    return this.run<{ page: CachePage; updates: Uint8Array[]; older: CachePage[] }>(
      (tx, done, fail) => {
        this.allowed(
          tx,
          ticket,
          () => {
            this.policyAllowed(
              tx,
              ticket,
              workspace,
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
          fail,
        );
      },
    );
  }
  private document(
    tx: IDBTransaction,
    page: CachePage,
    ticket: CacheTicket,
    next: (current: CachePage) => void,
    fail: (e: Error) => void,
  ) {
    this.policyAllowed(
      tx,
      ticket,
      page.workspace,
      () => {
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
      },
      fail,
    );
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
            ticket,
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
            ticket,
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
            ticket,
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
