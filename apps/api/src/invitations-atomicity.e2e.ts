import assert from 'node:assert/strict';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { test } from 'node:test';
import { sql } from 'drizzle-orm';
import { createAuth } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import { queueAuthMail } from '../../../packages/auth/src/recovery-core.ts';
import { testDatabase } from '../../collab/src/testing/database.ts';

await test('5b prerequisite: installed Better Auth shares the facade transaction and rolls back all effects', async () => {
  process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
  const fixture = await testDatabase();
  const connection = createDatabase(fixture.url);
  const options = {
    origin: process.env.APP_ORIGIN!,
    secret: process.env.BETTER_AUTH_SECRET!,
    sendVerificationEmail: async () => {},
  };
  const auth = createAuth(connection.db, options);
  try {
    async function account() {
      const email = `${randomUUID()}@example.test`,
        password = randomBytes(20).toString('hex');
      await auth.api.signUpEmail({ body: { email, password, name: 'Atomic fixture' } });
      await fixture.pool.query('UPDATE auth_users SET email_verified=true WHERE email=$1', [email]);
      const response = await auth.api.signInEmail({ body: { email, password }, asResponse: true });
      const headers = new Headers({
        cookie: response.headers
          .getSetCookie()
          .map((c) => c.split(';')[0])
          .join('; '),
      });
      const session = await auth.api.getSession({ headers });
      assert(session);
      return { email, headers, user: session.user.id };
    }
    const owner = await account(),
      guest = await account();
    await fixture.pool.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES($1,$2,'owner')",
      [fixture.workspace, owner.user],
    );
    const invited = await auth.api.createInvitation({
      headers: owner.headers,
      body: { organizationId: fixture.workspace, email: guest.email, role: 'guest' },
    });
    for (const stage of ['accepted', 'sidecars']) {
      await assert.rejects(
        connection.db.transaction(async (tx) => {
          const accepted = await createAuth(tx, options).api.acceptInvitation({
            headers: guest.headers,
            body: { invitationId: invited.id },
          });
          assert.equal(
            (
              await tx.execute(
                sql`SELECT status FROM workspace_invitations WHERE id=${invited.id}::uuid`,
              )
            ).rows[0]?.status,
            'accepted',
          );
          if (stage === 'sidecars') {
            const actor = randomUUID(),
              subject = randomUUID();
            await tx.execute(
              sql`INSERT INTO actors(id,workspace_id,user_id,kind) VALUES(${actor}::uuid,${fixture.workspace}::uuid,${guest.user}::uuid,'user')`,
            );
            await tx.execute(
              sql`INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES(${subject}::uuid,${fixture.workspace}::uuid,'member',${accepted.member.id}::uuid)`,
            );
            await tx.execute(
              sql`INSERT INTO access_grants(workspace_id,subject_id,resource_id,level) VALUES(${fixture.workspace}::uuid,${subject}::uuid,${fixture.page}::uuid,'read')`,
            );
            await tx.execute(
              sql`INSERT INTO audit_logs(workspace_id,action,resource_type,resource_id) VALUES(${fixture.workspace}::uuid,'test.accepted','invitation',${invited.id}::uuid)`,
            );
            await queueAuthMail(
              tx,
              options.secret,
              'delivery',
              { email: guest.email, subject: 'Atomic fixture', text: 'Accepted' },
              guest.user,
              undefined,
              false,
            );
          }
          throw new Error('ROLLBACK_PROBE');
        }),
        /ROLLBACK_PROBE/,
      );
      const result = (
        await fixture.pool.query(
          `SELECT
        (SELECT status FROM workspace_invitations WHERE id=$1) AS status,
        (SELECT count(*) FROM workspace_members WHERE user_id=$2) AS members,
        (SELECT count(*) FROM actors WHERE user_id=$2) AS actors,
        (SELECT count(*) FROM access_grants) AS grants,
        (SELECT count(*) FROM audit_logs WHERE resource_id=$1) AS audit,
        (SELECT count(*) FROM auth_mail_jobs WHERE user_id=$2) AS mail`,
          [invited.id, guest.user],
        )
      ).rows[0];
      assert.deepEqual(result, {
        status: 'pending',
        members: '0',
        actors: '0',
        grants: '0',
        audit: '0',
        mail: '0',
      });
      console.info(
        `PASS atomic rollback after ${stage}: invitation pending, no member/actor/grant/audit/mail`,
      );
    }
    const accepted = await connection.db.transaction((tx) =>
      createAuth(tx, options).api.acceptInvitation({
        headers: guest.headers,
        body: { invitationId: invited.id },
      }),
    );
    assert.equal(accepted.member.role, 'guest');
    assert.equal(
      (
        await fixture.pool.query('SELECT status FROM workspace_invitations WHERE id=$1', [
          invited.id,
        ])
      ).rows[0].status,
      'accepted',
    );
  } finally {
    await connection.pool.end();
    await fixture.close();
  }
});
