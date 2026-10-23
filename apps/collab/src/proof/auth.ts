import { randomBytes, randomUUID } from 'node:crypto';
import { createAuth } from '@memoria/auth';
import { createDatabase } from '@memoria/db';
import type { ProofDatabase } from './database.ts';

export async function proofAuth(fixture: ProofDatabase) {
  const url = new URL(process.env.DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${fixture.schema}`);
  const { db, pool } = createDatabase(url.toString());
  const origin = 'https://localhost';
  const auth = createAuth(db, {
    origin,
    secret: randomBytes(32).toString('hex'),
    sendVerificationEmail: async () => {},
  });
  async function account(name: string) {
    const email = `${randomUUID()}@example.test`,
      password = `Proof!${randomBytes(20).toString('hex')}`;
    const call = (path: string, body: object) =>
      auth.handler(
        new Request(`${origin}/api/auth/${path}`, {
          method: 'POST',
          headers: {
            'content-type': 'application/json',
            origin,
            'x-memoria-client-ip': randomUUID(),
          },
          body: JSON.stringify(body),
        }),
      );
    const signup = await call('sign-up/email', { email, password, name });
    if (!signup.ok) throw new Error(`Proof signup ${signup.status}`);
    await pool.query('UPDATE auth_users SET email_verified=true WHERE email=$1', [email]);
    const login = await call('sign-in/email', { email, password });
    if (!login.ok) throw new Error(`Proof login ${login.status}`);
    const cookie = login.headers
      .getSetCookie()
      .map((part) => part.split(';')[0])
      .join('; ');
    const verified = await auth.api.getSession({ headers: new Headers({ cookie }) });
    if (!verified) throw new Error('Better Auth session not found');
    await pool.query(
      "INSERT INTO workspace_members(workspace_id,user_id,role) VALUES ($1,$2,'member')",
      [fixture.workspace, verified.user.id],
    );
    await pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES ($1,$2,'user')", [
      fixture.workspace,
      verified.user.id,
    ]);
    return { cookie, user: verified.user.id, session: verified.session.id, name };
  }
  return { auth, pool, origin, account };
}
