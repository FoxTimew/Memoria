import { test } from 'node:test';
import assert from 'node:assert/strict';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { Leadership, assertFence } from '../service/leadership.ts';
await test('Real leadership: single owner, control loss, fencing and takeover', async () => {
  const db = await testDatabase();
  let lost = false;
  const first = new Leadership(db.url, () => {
      lost = true;
    }),
    second = new Leadership(db.url, () => {});
  try {
    const original = await first.start();
    await assert.rejects(second.start(), /LEADER_EXISTS/);
    await db.client.query('BEGIN');
    await assertFence(db.client, original);
    await db.client.query('COMMIT');
    await db.pool.query('SELECT pg_terminate_backend($1)', [original.pid]);
    const deadline = Date.now() + 3000;
    while (!lost && Date.now() < deadline) await delay(10);
    assert(lost);
    assert.throws(() => first.fence, /LEADERSHIP_LOST/);
    await db.client.query('BEGIN');
    await assert.rejects(assertFence(db.client, original), /LEADERSHIP_LOST/);
    await db.client.query('ROLLBACK');
    const replacement = new Leadership(db.url, () => {});
    try {
      const next = await replacement.start();
      assert(next.epoch > original.epoch);
      await db.client.query('BEGIN');
      await assertFence(db.client, next);
      await db.client.query('COMMIT');
      await assert.rejects(assertFence(db.client, original), /LEADERSHIP_LOST/);
    } finally {
      await replacement.close();
    }
    console.log(
      'PASS leadership: second instance denied; backend terminated; loss callback and stale fence denial; new owner succeeds',
    );
  } finally {
    await first.close();
    await second.close();
    await db.close();
  }
});
