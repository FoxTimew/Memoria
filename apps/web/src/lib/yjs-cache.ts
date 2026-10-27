import * as Y from 'yjs';

export const cacheDatabase = 'memoria-yjs-cache-v1';
export const legacyDatabase = 'memoria-local-drafts-v1';
const stores = ['users', 'sessions', 'documents', 'updates', 'policies', 'pagePolicies'];
export const pageAccessKey = (workspace: string, page: string) => JSON.stringify([workspace, page]);
type PagePolicy = {
  user: string;
  workspace: string;
  page: string;
  version: number;
  epoch: number;
  allowed: boolean;
  scope?: 'base' | 'row';
  database?: string;
  lifecycle?: string;
};
export type RowScope = { database: string; baseVersion: number; lifecycle: string };
export type RowSnapshot = {
  bases: (
    | { database: string; available: false }
    | { database: string; available: true; version: number; level: 'read' | 'edit' }
  )[];
  rows: (
    | { database: string; row: string; available: false }
    | { database: string; row: string; available: true; level: 'read' | 'edit'; rowScope: RowScope }
  )[];
};
const basePolicyId = (database: string) => `base:${database}`;
type PageSnapshot = {
  accessVersion: number;
  pages: { page: string; version: number; level: 'read' | 'edit' }[];
};
const maxBytes = 8 * 1024 ** 2;
export class LocalSessionRevoked extends Error {
  readonly status = 401;
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
export class AccessChanged extends Error {
  readonly status = 409;
  constructor() {
    super('Vos accès ont changé. Rechargez la page pour continuer.');
  }
}
export type CacheTicket = {
  user: string;
  session: string;
  epoch: number;
  marker: string;
  policies: Record<string, number>;
  observedPolicyEpochs: Record<string, number>;
  accessVersions: Record<string, number>;
  checkedAccessVersions: Record<string, number>;
  pageAccess: Record<string, { version: number; epoch: number }>;
  observedPageEpochs: Record<string, number>;
  rowChecks: Record<string, RowScope>;
};
export type CachePolicy = {
  user: string;
  session: string;
  sharedComputer: boolean;
  workspaces: { workspace: string; version: number; accessVersion?: number; allowed: boolean }[];
};
type Policy = {
  user: string;
  workspace: string;
  version: number;
  accessVersion: number;
  revoked?: boolean;
  allowed: boolean;
  epoch: number;
  checkedAccessVersion?: number;
  legacyAccessVersion?: number;
};
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
  database?: string;
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
  upgrade: (db: IDBDatabase, tx: IDBTransaction, oldVersion: number) => void,
) {
  return new Promise<IDBDatabase>((resolve, reject) => {
    const request = factory.open(name, version);
    let failed = false;
    request.onupgradeneeded = (event) =>
      upgrade(request.result, request.transaction!, event.oldVersion);
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
    const db = await openDatabase(this.factory(), this.name, 4, (db, upgrade, oldVersion) => {
      // Old copies have no access epoch. Retain logout tombstones, retire only content/policies.
      if (oldVersion < 3)
        for (const store of ['documents', 'updates', 'policies'])
          if (db.objectStoreNames.contains(store)) db.deleteObjectStore(store);
      if (!db.objectStoreNames.contains('policies')) {
        const policies = db.createObjectStore('policies', { keyPath: ['user', 'workspace'] });
        policies.createIndex('user', 'user');
      } else {
        const cursor = upgrade.objectStore('policies').openCursor();
        cursor.onsuccess = () => {
          const c = cursor.result;
          if (c) {
            c.update({
              ...c.value,
              legacyAccessVersion: c.value.accessVersion,
              checkedAccessVersion: 0,
            });
            c.continue();
          }
        };
      }
      const pagePolicies = db.createObjectStore('pagePolicies', {
        keyPath: ['user', 'workspace', 'page'],
      });
      pagePolicies.createIndex('user', 'user');
      pagePolicies.createIndex('workspace', ['user', 'workspace']);
      if (!db.objectStoreNames.contains('users')) {
        db.createObjectStore('users', { keyPath: 'user' });
        const sessions = db.createObjectStore('sessions', { keyPath: ['user', 'session'] });
        sessions.createIndex('user', 'user');
      }
      if (!db.objectStoreNames.contains('documents')) {
        const documents = db.createObjectStore('documents', { keyPath: 'key' });
        documents.createIndex('user', 'user');
        const updates = db.createObjectStore('updates', { keyPath: 'id', autoIncrement: true });
        updates.createIndex('key', 'key');
        updates.createIndex('user', 'user');
      }
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
    policyOnly = false,
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
          if ((session.result as Session).disabled && !policyOnly) {
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
        epoch.onsuccess = () => {
          const observed = tx.objectStore('policies').index('user').getAll(user);
          observed.onsuccess = () => {
            const pagePolicies = tx.objectStore('pagePolicies').index('user').getAll(user);
            pagePolicies.onsuccess = () =>
              done({
                user,
                session,
                marker,
                epoch: epoch.result?.epoch ?? 0,
                policies: {},
                rowChecks: {},
                accessVersions: {},
                checkedAccessVersions: Object.fromEntries(
                  (observed.result as Policy[]).map((p) => [
                    p.workspace,
                    p.checkedAccessVersion ?? 0,
                  ]),
                ),
                pageAccess: Object.fromEntries(
                  (pagePolicies.result as PagePolicy[])
                    .filter((p) => p.allowed)
                    .map((p) => [
                      pageAccessKey(p.workspace, p.page),
                      { version: p.version, epoch: p.epoch },
                    ]),
                ),
                observedPageEpochs: Object.fromEntries(
                  (pagePolicies.result as PagePolicy[]).map((p) => [
                    pageAccessKey(p.workspace, p.page),
                    p.epoch,
                  ]),
                ),
                observedPolicyEpochs: Object.fromEntries(
                  (observed.result as Policy[]).map((p) => [p.workspace, p.epoch]),
                ),
              });
          };
        };
      };
    });
  }
  assertActive(ticket: CacheTicket, workspace?: string, page?: string) {
    return this.run<void>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () =>
          workspace ? this.policyAllowed(tx, ticket, workspace, () => done(), fail, page) : done(),
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
    page?: string,
  ) {
    const read = tx.objectStore('policies').get([ticket.user, workspace]);
    read.onsuccess = () => {
      const policy = read.result as Policy | undefined;
      if (policy && policy.revoked) {
        fail(new AccessChanged());
        return;
      }
      if (!policy?.allowed || ticket.policies[workspace] !== policy.epoch) {
        fail(new CacheForbidden());
        return;
      }
      if (!page) {
        next();
        return;
      }
      const pageRead = tx.objectStore('pagePolicies').get([ticket.user, workspace, page]);
      pageRead.onsuccess = () => {
        const current = pageRead.result as PagePolicy | undefined;
        const expected = ticket.pageAccess[pageAccessKey(workspace, page)];
        if (
          !current?.allowed ||
          !expected ||
          current.version !== expected.version ||
          current.epoch !== expected.epoch
        ) {
          fail(new AccessChanged());
          return;
        }
        if (current.scope === 'row') {
          const checked = ticket.rowChecks[pageAccessKey(workspace, page)];
          if (
            !checked ||
            checked.database !== current.database ||
            checked.baseVersion !== current.version ||
            checked.lifecycle !== current.lifecycle
          ) {
            fail(new AccessChanged());
            return;
          }
          const base = tx
            .objectStore('pagePolicies')
            .get([ticket.user, workspace, basePolicyId(checked.database)]);
          base.onsuccess = () => {
            const actual = base.result as PagePolicy | undefined,
              expected =
                ticket.pageAccess[pageAccessKey(workspace, basePolicyId(checked.database))];
            if (
              !actual?.allowed ||
              !expected ||
              actual.version !== checked.baseVersion ||
              actual.epoch !== expected.epoch
            ) {
              fail(new AccessChanged());
              return;
            }
            next();
          };
        } else next();
      };
    };
  }
  /** Consume a fresh server decision. The pre-request ticket fences delayed HTTP responses. */
  async applyPolicy(ticket: CacheTicket, snapshot: CachePolicy) {
    if (snapshot.user !== ticket.user || snapshot.session !== ticket.session)
      return Promise.reject(new LocalSessionRevoked());
    if (snapshot.sharedComputer) await this.disableUser(ticket);
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
            const accessVersions: Record<string, number> = {};
            for (const proposed of snapshot.workspaces) {
              const old = known.get(proposed.workspace);
              known.delete(proposed.workspace);
              const accessVersion = proposed.accessVersion ?? 1;
              if (old && (old.version > proposed.version || old.accessVersion > accessVersion))
                continue;
              // Membership removal does not change the workspace's policy version.
              // A response begun before that local revocation cannot undo its tombstone.
              if (
                old &&
                !old.allowed &&
                proposed.allowed &&
                old.version === proposed.version &&
                ticket.observedPolicyEpochs[proposed.workspace] !== old.epoch
              )
                continue;
              const current: Policy = {
                ...old,
                ...proposed,
                revoked: false,
                accessVersion,
                user: ticket.user,
                epoch: (old?.epoch ?? 0) + (old && old.allowed !== proposed.allowed ? 1 : 0),
              };
              store.put(current);
              accessVersions[current.workspace] = accessVersion;
              if (current.allowed) policies[current.workspace] = current.epoch;
              else this.purgeWorkspace(tx, ticket.user, current.workspace);
            }
            // Membership disappearance revokes local copies too; this is never an authorization source.
            for (const old of known.values()) {
              store.put({
                ...old,
                revoked: true,
                allowed: false,
                epoch: old.epoch + (old.allowed ? 1 : 0),
              });
              this.purgeWorkspace(tx, ticket.user, old.workspace);
            }
            done({ ...ticket, policies, accessVersions });
          };
        },
        fail,
        true,
      ),
    );
  }
  applyPageAccess(ticket: CacheTicket, workspace: string, snapshot: PageSnapshot) {
    return this.run<CacheTicket>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () => {
          const policies = tx.objectStore('policies'),
            read = policies.get([ticket.user, workspace]);
          read.onsuccess = () => {
            const policy = read.result as Policy | undefined;
            if (!policy || policy.revoked) {
              fail(new AccessChanged());
              return;
            }
            if (
              snapshot.accessVersion < policy.accessVersion ||
              snapshot.accessVersion < (policy.checkedAccessVersion ?? 0)
            ) {
              done(ticket);
              return;
            }
            const pagePolicies = tx.objectStore('pagePolicies');
            const previous = pagePolicies.index('workspace').getAll([ticket.user, workspace]);
            previous.onsuccess = () => {
              const documents = tx.objectStore('documents').index('user').getAll(ticket.user);
              documents.onsuccess = () => {
                const cached = (documents.result as CachePage[]).filter(
                  (p) => p.workspace === workspace && !p.database,
                );
                const cachedIds = new Set(cached.map((p) => p.page));
                const known = new Map(
                  (previous.result as PagePolicy[]).filter((p) => !p.scope).map((p) => [p.page, p]),
                );
                const fresh = new Map(snapshot.pages.map((p) => [p.page, p]));
                const pageAccess = { ...ticket.pageAccess },
                  observedPageEpochs = { ...ticket.observedPageEpochs };
                const ids = new Set([
                  ...known.keys(),
                  ...fresh.keys(),
                  ...cached.map((p) => p.page),
                ]);
                for (const page of ids) {
                  const old = known.get(page),
                    proposed = fresh.get(page),
                    key = pageAccessKey(workspace, page);
                  delete pageAccess[key];
                  if (
                    old &&
                    (old.version > (proposed?.version ?? snapshot.accessVersion) ||
                      (!old.allowed &&
                        proposed?.version === old.version &&
                        ticket.observedPageEpochs[key] !== old.epoch))
                  )
                    continue;
                  const allowed = proposed !== undefined;
                  const version =
                    proposed?.version ??
                    (!old?.allowed && old ? old.version : snapshot.accessVersion);
                  const changed = old ? old.allowed !== allowed || old.version !== version : false;
                  const current: PagePolicy = {
                    user: ticket.user,
                    workspace,
                    page,
                    allowed,
                    version,
                    epoch: (old?.epoch ?? 0) + (changed ? 1 : 0),
                  };
                  pagePolicies.put(current);
                  observedPageEpochs[key] = current.epoch;
                  if (allowed) pageAccess[key] = { version, epoch: current.epoch };
                  if (
                    cachedIds.has(page) &&
                    (!allowed || changed || (!old && policy.legacyAccessVersion !== version))
                  )
                    this.purgePage(tx, ticket.user, workspace, page);
                }
                policies.put({
                  ...policy,
                  accessVersion: snapshot.accessVersion,
                  checkedAccessVersion: snapshot.accessVersion,
                  legacyAccessVersion: undefined,
                });
                done({
                  ...ticket,
                  pageAccess,
                  observedPageEpochs,
                  accessVersions: { ...ticket.accessVersions, [workspace]: snapshot.accessVersion },
                  checkedAccessVersions: {
                    ...ticket.checkedAccessVersions,
                    [workspace]: snapshot.accessVersion,
                  },
                });
              };
            };
          };
        },
        fail,
        true,
      ),
    );
  }
  private purgePage(tx: IDBTransaction, user: string, workspace: string, pageId: string) {
    const read = tx.objectStore('documents').index('user').openCursor(user);
    read.onsuccess = () => {
      const cursor = read.result;
      if (!cursor) return;
      const page = cursor.value as CachePage;
      if (page.workspace === workspace && page.page === pageId) {
        this.remove(tx.objectStore('updates').index('key').openCursor(page.key));
        cursor.delete();
      }
      cursor.continue();
    };
  }
  /** Partial row check, never a workspace snapshot. Acquire ticket before the HTTP request.
   * Base epochs fence ALL of that base's rows; lifecycle epochs fence only one row. */
  applyRowAccess(ticket: CacheTicket, workspace: string, snapshot: RowSnapshot) {
    return this.run<CacheTicket>((tx, done, fail) =>
      this.allowed(
        tx,
        ticket,
        () => {
          const store = tx.objectStore('pagePolicies'),
            read = store.index('workspace').getAll([ticket.user, workspace]);
          read.onsuccess = () => {
            const known = new Map((read.result as PagePolicy[]).map((p) => [p.page, p]));
            const docs = tx.objectStore('documents').index('user').getAll(ticket.user);
            docs.onsuccess = () => {
              const cached = (docs.result as CachePage[]).filter((p) => p.workspace === workspace);
              const next = {
                ...ticket,
                pageAccess: { ...ticket.pageAccess },
                observedPageEpochs: { ...ticket.observedPageEpochs },
                rowChecks: { ...ticket.rowChecks },
              };
              const acceptedBases = new Map<string, PagePolicy>();
              const apply = (page: string, proposed: PagePolicy) => {
                const old = known.get(page),
                  key = pageAccessKey(workspace, page);
                delete next.pageAccess[key];
                delete next.rowChecks[key];
                if (
                  old &&
                  (old.version > proposed.version ||
                    (old.lifecycle &&
                      proposed.lifecycle &&
                      BigInt(old.lifecycle) > BigInt(proposed.lifecycle)) ||
                    (!old.allowed &&
                      proposed.allowed &&
                      old.version === proposed.version &&
                      ticket.observedPageEpochs[key] !== old.epoch))
                )
                  return;
                const changed =
                  !!old &&
                  (old.allowed !== proposed.allowed ||
                    old.version !== proposed.version ||
                    old.lifecycle !== proposed.lifecycle);
                const current = { ...proposed, epoch: (old?.epoch ?? 0) + (changed ? 1 : 0) };
                store.put(current);
                known.set(page, current);
                next.observedPageEpochs[key] = current.epoch;
                if (current.allowed)
                  next.pageAccess[key] = { version: current.version, epoch: current.epoch };
                if (!current.allowed || changed) {
                  for (const doc of cached)
                    if (
                      current.scope === 'base'
                        ? doc.database === current.database
                        : doc.page === page
                    )
                      this.purgePage(tx, ticket.user, workspace, doc.page);
                }
                return current;
              };
              for (const base of snapshot.bases) {
                const page = basePolicyId(base.database),
                  old = known.get(page);
                const current = apply(page, {
                  user: ticket.user,
                  workspace,
                  page,
                  scope: 'base',
                  database: base.database,
                  version: base.available ? base.version : (old?.version ?? 0),
                  epoch: 0,
                  allowed: base.available,
                });
                if (current?.allowed) acceptedBases.set(base.database, current);
              }
              for (const row of snapshot.rows) {
                const base = acceptedBases.get(row.database),
                  old = known.get(row.row),
                  key = pageAccessKey(workspace, row.row);
                const allowed = row.available && base?.version === row.rowScope.baseVersion;
                const current = apply(row.row, {
                  user: ticket.user,
                  workspace,
                  page: row.row,
                  scope: 'row',
                  database: row.database,
                  version: base?.version ?? old?.version ?? 0,
                  epoch: 0,
                  allowed: !!allowed,
                  ...(row.available
                    ? { lifecycle: row.rowScope.lifecycle }
                    : old?.lifecycle
                      ? { lifecycle: old.lifecycle }
                      : {}),
                });
                if (current?.allowed && row.available) next.rowChecks[key] = row.rowScope;
              }
              done(next);
            };
          };
        },
        fail,
        true,
      ),
    );
  }
  revokePage(ticket: CacheTicket, workspace: string, page: string) {
    return this.run<void>((tx, done) => {
      const store = tx.objectStore('pagePolicies'),
        read = store.get([ticket.user, workspace, page]);
      read.onsuccess = () => {
        const old = read.result as PagePolicy | undefined,
          expected = ticket.pageAccess[pageAccessKey(workspace, page)];
        if (old && expected && (old.version !== expected.version || old.epoch !== expected.epoch)) {
          done();
          return;
        }
        if (old) store.put({ ...old, allowed: false, epoch: old.epoch + 1 });
        this.purgePage(tx, ticket.user, workspace, page);
        done();
      };
    });
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
  /** Purge the whole affected workspace and fence delayed reads/writes, even without a cache. */
  revokeWorkspace(ticket: CacheTicket, workspace: string) {
    return this.run<void>((tx, done) => {
      const store = tx.objectStore('policies'),
        read = store.get([ticket.user, workspace]);
      read.onsuccess = () => {
        const old = read.result as Policy | undefined;
        // A delayed old tab must not revoke a freshly opened replica at a newer epoch.
        // That epoch already purged the old bytes atomically in applyPolicy.
        if (
          old &&
          ticket.accessVersions[workspace] !== undefined &&
          old.accessVersion !== ticket.accessVersions[workspace]
        ) {
          done();
          return;
        }
        if (old) store.put({ ...old, revoked: true, allowed: false, epoch: old.epoch + 1 });
        this.purgeWorkspace(tx, ticket.user, workspace);
        done();
      };
    });
  }
  accessStamp(user: string, workspace: string, page?: string) {
    return this.run<string>((tx, done) => {
      if (page) {
        const read = tx.objectStore('pagePolicies').get([user, workspace, page]);
        read.onsuccess = () => {
          const p = read.result as PagePolicy | undefined;
          done(p ? `${p.version}:${p.epoch}:${p.allowed}` : '');
        };
        return;
      }
      const r = tx.objectStore('policies').get([user, workspace]);
      r.onsuccess = () => {
        const p = r.result as Policy | undefined;
        done(p ? `${p.accessVersion}:${p.revoked === true}` : '');
      };
    });
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
  cachedRows(user: string) {
    return this.run<CachePage[]>((tx, done) => {
      const read = tx.objectStore('documents').index('user').getAll(user);
      read.onsuccess = () => done((read.result as CachePage[]).filter((p) => !!p.database));
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
                if (
                  !ticket.rowChecks[pageAccessKey(workspace, page)] &&
                  ticket.accessVersions[workspace] !== ticket.checkedAccessVersions[workspace]
                ) {
                  fail(new AccessChanged());
                  return;
                }
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
                    ...(ticket.rowChecks[pageAccessKey(workspace, page)]
                      ? { database: ticket.rowChecks[pageAccessKey(workspace, page)]!.database }
                      : {}),
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
              page,
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
      page.page,
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
