import { describe, it, expect } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import * as Y from 'yjs';
import { YjsCache, AccessChanged, LocalSessionRevoked } from './yjs-cache.ts';
import type { RowSnapshot } from './yjs-cache.ts';
function snapshot(version = 1, lifecycle = '1'): RowSnapshot {
  return {
    bases: [
      { database: 'base', available: true, version, level: 'edit' },
      { database: 'other', available: true, version: 1, level: 'edit' },
    ],
    rows: [
      {
        database: 'base',
        row: 'r',
        available: true,
        level: 'edit',
        rowScope: { database: 'base', baseVersion: version, lifecycle },
      },
      {
        database: 'base',
        row: 's',
        available: true,
        level: 'edit',
        rowScope: { database: 'base', baseVersion: version, lifecycle: '1' },
      },
      {
        database: 'other',
        row: 'z',
        available: true,
        level: 'edit',
        rowScope: { database: 'other', baseVersion: 1, lifecycle: '1' },
      },
    ],
  };
}
async function fixture() {
  const db = new IDBFactory(),
    store = new YjsCache(
      () => db,
      () => '',
    ),
    policy = {
      user: 'u',
      session: 's',
      sharedComputer: false,
      workspaces: [{ workspace: 'w', version: 1, accessVersion: 1, allowed: true }],
    };
  const ticket = await store.applyPolicy(await store.ticket('u', 's'), policy),
    fresh = await store.applyRowAccess(ticket, 'w', snapshot());
  const doc = new Y.Doc();
  doc.getText('t').insert(0, 'offline');
  const update = Y.encodeStateAsUpdate(doc);
  doc.destroy();
  const records = [];
  for (const row of ['r', 's', 'z']) {
    const opened = await store.open(fresh, 'w', row, 'g');
    await store.append(fresh, opened.page, update, 'receipt');
    records.push(opened.page);
  }
  return { store, ticket: fresh, records, update, policy };
}
describe('native row cache barriers', () => {
  it('requires a fresh online base/row decision on reopening and preserves bytes after it', async () => {
    const f = await fixture(),
      unverified = await f.store.applyPolicy(await f.store.ticket('u', 's'), f.policy);
    await expect(f.store.open(unverified, 'w', 'r', 'g')).rejects.toBeInstanceOf(AccessChanged);
    const verified = await f.store.applyRowAccess(unverified, 'w', snapshot());
    expect((await f.store.open(verified, 'w', 'r', 'g')).updates.length).toBe(1);
  });
  it('ordinary sidebar snapshots never purge row caches', async () => {
    const f = await fixture();
    const t = await f.store.applyPageAccess(f.ticket, 'w', { accessVersion: 2, pages: [] });
    expect((await f.store.open(t, 'w', 'r', 'g')).updates.length).toBe(1);
  });
  it('base epoch reduction purges only that base and fences frozen writers', async () => {
    const f = await fixture();
    const next = await f.store.applyRowAccess(await f.store.ticket('u', 's'), 'w', snapshot(2));
    await expect(f.store.append(f.ticket, f.records[0]!, f.update, 'late')).rejects.toBeInstanceOf(
      AccessChanged,
    );
    const ready = await f.store.applyPolicy(next, f.policy);
    expect((await f.store.open(ready, 'w', 'r', 'g')).updates.length).toBe(0);
    expect((await f.store.open(ready, 'w', 'z', 'g')).updates.length).toBe(1);
  });
  it('row archive purges only that row and rejects a delayed HTTP grant', async () => {
    const f = await fixture(),
      reply = snapshot();
    reply.rows = [{ database: 'base', row: 'r', available: false }];
    await f.store.applyRowAccess(await f.store.ticket('u', 's'), 'w', reply);
    const stale = await f.store.applyRowAccess(f.ticket, 'w', snapshot());
    await expect(f.store.open(stale, 'w', 'r', 'g')).rejects.toBeInstanceOf(AccessChanged);
    expect((await f.store.open(f.ticket, 'w', 's', 'g')).updates.length).toBe(1);
    const fresh = await f.store.applyRowAccess(
      await f.store.ticket('u', 's'),
      'w',
      snapshot(1, '2'),
    );
    expect(
      (await f.store.open(await f.store.applyPolicy(fresh, f.policy), 'w', 'r', 'g')).updates
        .length,
    ).toBe(0);
  });
  it('a revoked base fences unrequested cached rows; stale reply cannot restore it', async () => {
    const f = await fixture();
    await f.store.applyRowAccess(await f.store.ticket('u', 's'), 'w', {
      bases: [{ database: 'base', available: false }],
      rows: [{ database: 'base', row: 'r', available: false }],
    });
    await expect(f.store.append(f.ticket, f.records[1]!, f.update, 'late')).rejects.toBeInstanceOf(
      AccessChanged,
    );
    const old = await f.store.applyRowAccess(f.ticket, 'w', snapshot());
    await expect(f.store.open(old, 'w', 'r', 'g')).rejects.toBeInstanceOf(AccessChanged);
    expect((await f.store.open(f.ticket, 'w', 'z', 'g')).updates.length).toBe(1);
  });
  it('lifecycle cannot go backwards after archive/restore', async () => {
    const f = await fixture(),
      next = await f.store.applyRowAccess(f.ticket, 'w', snapshot(1, '3'));
    const stale = await f.store.applyRowAccess(
      await f.store.ticket('u', 's'),
      'w',
      snapshot(1, '1'),
    );
    await expect(
      f.store.open(await f.store.applyPolicy(stale, f.policy), 'w', 'r', 'g'),
    ).rejects.toBeInstanceOf(AccessChanged);
    expect((await f.store.open(next, 'w', 'r', 'g')).updates.length).toBe(0);
  });
  it('logout tombstones also fence row decisions and data in another tab', async () => {
    const f = await fixture();
    await f.store.clearUser('u', 's');
    await expect(f.store.applyRowAccess(f.ticket, 'w', snapshot())).rejects.toBeInstanceOf(
      LocalSessionRevoked,
    );
    await expect(f.store.append(f.ticket, f.records[0]!, f.update, 'late')).rejects.toBeInstanceOf(
      LocalSessionRevoked,
    );
    expect(await f.store.pending('u')).toBe(0);
  });
  it('cache prohibition purges rows and prevents reopening even with valid row rights', async () => {
    const f = await fixture();
    const prohibited = await f.store.applyPolicy(await f.store.ticket('u', 's'), {
      ...f.policy,
      workspaces: [{ workspace: 'w', version: 2, accessVersion: 1, allowed: false }],
    });
    expect(await f.store.pending('u')).toBe(0);
    await expect(
      f.store.open(await f.store.applyRowAccess(prohibited, 'w', snapshot()), 'w', 'r', 'g'),
    ).rejects.toThrow();
  });
});
