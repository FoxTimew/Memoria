import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { setTimeout as delay } from 'node:timers/promises';
import { testDatabase } from './database.ts';
import { resolveAccess } from '../service/access.ts';
import { Leadership } from '../service/leadership.ts';
import { Store } from '../service/store.ts';

test('Cached authorization plans preserve the SQL oracle and independently expected decisions', async (t) => {
  const db = await testDatabase();
  const factor = randomUUID(),
    totp = randomUUID(),
    foreign = randomUUID(),
    foreignFactor = randomUUID();
  try {
    // Freeze the pre-optimization functions from their actual immutable migrations.
    for (const file of [
      '0008_session_assurance_boundary.sql',
      '0010_workspace_security_boundary.sql',
      '0012_recovery_boundary.sql',
    ]) {
      const source = await readFile(`packages/db/drizzle/${file}`, 'utf8');
      for (const statement of source.split('--> statement-breakpoint'))
        if (
          /CREATE (OR REPLACE )?FUNCTION auth_session_(is_strong|can_access_content|can_access_workspace)\(/.test(
            statement,
          )
        )
          await db.client.query(statement.replaceAll('auth_session_', 'legacy_auth_session_'));
    }
    await db.client.query(
      "INSERT INTO auth_users(id,name,email,email_verified) VALUES($1,'Other',$2,true)",
      [foreign, `${foreign}@example.test`],
    );
    for (const [id, user] of [
      [factor, db.user],
      [foreignFactor, foreign],
    ])
      await db.client.query(
        "INSERT INTO auth_passkeys(id,user_id,public_key,credential_id,counter,device_type,backed_up) VALUES($1,$2,'fixture',$3,0,'singleDevice',false)",
        [id, user, randomUUID()],
      );
    await db.client.query(
      "INSERT INTO auth_two_factors(id,user_id,secret,backup_codes,verified) VALUES($1,$2,'fixture','[]',true)",
      [totp, db.user],
    );
    await db.client.query('INSERT INTO account_security(user_id,version) VALUES($1,0)', [db.user]);
    await db.client.query(
      "INSERT INTO session_assurance(session_id,method,verified_at,security_version,factor_id) VALUES($1,'passkey',now(),0,$2)",
      [db.session, factor],
    );
    await db.client.query(
      'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())',
      [db.workspace],
    );
    const identity = { ...db, key: 'test' };
    const check = async (expected: boolean[], access = expected[2]) => {
      for (const prefix of ['', 'legacy_']) {
        const result = (
          await db.client.query(
            `SELECT ${prefix}auth_session_is_strong($1) AS strong,${prefix}auth_session_can_access_content($1) AS content,${prefix}auth_session_can_access_workspace($1,$2) AS workspace`,
            [db.session, db.workspace],
          )
        ).rows[0];
        assert.deepEqual([result.strong, result.content, result.workspace], expected);
      }
      assert.equal((await resolveAccess(db.client, [identity])).has(identity.key), access);
    };
    for (let i = 0; i < 12; i++) await check([true, true, true]);
    const query = (text: string, values: unknown[] = []) => db.client.query(text, values);
    const weak = async () => {
      await query('DELETE FROM session_assurance WHERE session_id=$1', [db.session]);
      await query('DELETE FROM auth_passkeys WHERE user_id=$1', [db.user]);
      await query('DELETE FROM auth_two_factors WHERE user_id=$1', [db.user]);
    };
    const scenarios: {
      name: string;
      change: () => Promise<unknown>;
      expected: boolean[];
      access?: boolean;
    }[] = [
      { name: 'live passkey', change: async () => {}, expected: [true, true, true] },
      {
        name: 'expired session',
        change: () =>
          query("UPDATE auth_sessions SET expires_at=now()-interval '1 second' WHERE id=$1", [
            db.session,
          ]),
        expected: [false, false, false],
      },
      {
        name: 'unverified email',
        change: () => query('UPDATE auth_users SET email_verified=false WHERE id=$1', [db.user]),
        expected: [false, false, false],
      },
      {
        name: 'future assurance',
        change: () =>
          query(
            "UPDATE session_assurance SET verified_at=now()+interval '1 hour' WHERE session_id=$1",
            [db.session],
          ),
        expected: [false, false, false],
      },
      {
        name: 'security generation changed',
        change: () =>
          query('UPDATE account_security SET version=version+1 WHERE user_id=$1', [db.user]),
        expected: [false, false, false],
      },
      {
        name: 'recovery session',
        change: () =>
          query("UPDATE session_assurance SET method='recovery' WHERE session_id=$1", [db.session]),
        expected: [false, false, false],
      },
      {
        name: 'account recovery required despite live proof',
        change: () =>
          query('UPDATE account_security SET recovery_required=true WHERE user_id=$1', [db.user]),
        expected: [true, false, false],
      },
      {
        name: 'factor belongs to another user',
        change: () =>
          query('UPDATE session_assurance SET factor_id=$2 WHERE session_id=$1', [
            db.session,
            foreignFactor,
          ]),
        expected: [false, false, false],
      },
      {
        name: 'verified TOTP',
        change: async () => {
          await query('UPDATE auth_users SET two_factor_enabled=true WHERE id=$1', [db.user]);
          await query(
            "UPDATE session_assurance SET method='totp',factor_id=$2 WHERE session_id=$1",
            [db.session, totp],
          );
        },
        expected: [true, true, true],
      },
      {
        name: 'unverified TOTP',
        change: async () => {
          await query('UPDATE auth_users SET two_factor_enabled=true WHERE id=$1', [db.user]);
          await query('UPDATE auth_two_factors SET verified=false WHERE id=$1', [totp]);
          await query(
            "UPDATE session_assurance SET method='totp',factor_id=$2 WHERE session_id=$1",
            [db.session, totp],
          );
        },
        expected: [false, false, false],
      },
      {
        name: 'configured factor without proof cannot use grace',
        change: async () => {
          await query('DELETE FROM session_assurance WHERE session_id=$1', [db.session]);
          await query(
            "UPDATE workspace_members SET mfa_deadline=now()+interval '1 hour' WHERE user_id=$1",
            [db.user],
          );
        },
        expected: [false, false, false],
      },
      {
        name: 'weak member with active grace',
        change: async () => {
          await weak();
          await query(
            "UPDATE workspace_members SET mfa_deadline=now()+interval '1 hour' WHERE user_id=$1",
            [db.user],
          );
        },
        expected: [false, true, true],
      },
      {
        name: 'weak member after grace',
        change: async () => {
          await weak();
          await query(
            "UPDATE workspace_members SET mfa_deadline=now()-interval '1 second' WHERE user_id=$1",
            [db.user],
          );
        },
        expected: [false, true, false],
      },
      {
        name: 'weak member without obligation',
        change: async () => {
          await weak();
          await query(
            'UPDATE workspace_policies SET require_strong_auth=false WHERE workspace_id=$1',
            [db.workspace],
          );
        },
        expected: [false, true, true],
      },
      {
        name: 'membership removed',
        change: () => query('DELETE FROM workspace_members WHERE user_id=$1', [db.user]),
        expected: [true, true, false],
      },
      {
        name: 'workspace archived',
        change: () => query('UPDATE workspaces SET deleted_at=now() WHERE id=$1', [db.workspace]),
        expected: [true, true, false],
      },
      {
        name: 'page archived',
        change: () => query('UPDATE pages SET deleted_at=now() WHERE id=$1', [db.page]),
        expected: [true, true, true],
        access: false,
      },
      {
        name: 'session removed',
        change: () => query('DELETE FROM auth_sessions WHERE id=$1', [db.session]),
        expected: [false, false, false],
      },
    ];
    for (const scenario of scenarios)
      await t.test(scenario.name, async () => {
        await query('BEGIN');
        try {
          await scenario.change();
          await check(scenario.expected, scenario.access);
        } finally {
          await query('ROLLBACK');
        }
        await check([true, true, true]); // Warm plans also observe restoration, not a cached denial.
      });
  } finally {
    await db.close();
  }
});

test('Warmed journal plans see security revocation committed while the writer waits for its page lock', async () => {
  const db = await testDatabase(),
    leader = new Leadership(db.url, () => {});
  await leader.start();
  const store = new Store(db.pool, leader),
    identity = { ...db, key: 'writer' },
    factor = randomUUID();
  const blocker = await db.pool.connect();
  try {
    await db.pool.query(
      "INSERT INTO auth_passkeys(id,user_id,public_key,credential_id,counter,device_type,backed_up) VALUES($1,$2,'fixture',$3,0,'singleDevice',false)",
      [factor, db.user, randomUUID()],
    );
    await db.pool.query('INSERT INTO account_security(user_id,version) VALUES($1,0)', [db.user]);
    await db.pool.query(
      "INSERT INTO session_assurance(session_id,method,verified_at,security_version,factor_id) VALUES($1,'passkey',now(),0,$2)",
      [db.session, factor],
    );
    await db.pool.query(
      'INSERT INTO workspace_policies(workspace_id,require_strong_auth,grace_days,strong_auth_enabled_at) VALUES($1,true,0,now())',
      [db.workspace],
    );
    const state = await store.open(identity);
    const update = new Uint8Array([0, 0]);
    const append = (revision: number) =>
      store.append(
        state.generation,
        revision,
        [{ identity, receipt: randomUUID(), update }],
        update,
        [],
        [],
      );
    for (let i = 1; i <= 12; i++) await append(i);
    const before = (
      await db.pool.query('SELECT content_revision FROM collaboration_documents WHERE page_id=$1', [
        db.page,
      ])
    ).rows[0].content_revision;
    await blocker.query('BEGIN');
    await blocker.query('UPDATE account_security SET version=version+1 WHERE user_id=$1', [
      db.user,
    ]);
    const blockerPid = (await blocker.query('SELECT pg_backend_pid() AS pid')).rows[0].pid;
    const writing = append(Number(before));
    const outcome = writing.then(
      () => null,
      (error: unknown) => error,
    );
    const deadline = Date.now() + 5000;
    let waiting = false;
    while (!waiting && Date.now() < deadline) {
      waiting = Boolean(
        (
          await db.client.query(
            'SELECT EXISTS(SELECT 1 FROM pg_stat_activity WHERE $1=ANY(pg_blocking_pids(pid))) AS blocked',
            [blockerPid],
          )
        ).rows[0].blocked,
      );
      if (!waiting) await delay(20);
    }
    assert(waiting, 'Writer must actually wait behind the security trigger/page lock');
    await blocker.query('COMMIT');
    const error = await outcome;
    assert(error instanceof Error && error.message === 'ACCESS_DENIED');
    assert.equal(
      (
        await db.pool.query(
          'SELECT content_revision FROM collaboration_documents WHERE page_id=$1',
          [db.page],
        )
      ).rows[0].content_revision,
      before,
    );
  } finally {
    await blocker.query('ROLLBACK');
    blocker.release();
    await leader.close();
    await db.close();
  }
});
