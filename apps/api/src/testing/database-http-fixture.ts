import 'reflect-metadata';
import { randomBytes, randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import assert from 'node:assert/strict';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import { createAuth, throttleKey } from '@memoria/auth';
import { AppModule, configureApplication } from '../app.ts';
import { DatabaseService } from '../database.module.ts';
import { DatabasesService } from '../modules/databases/databases.service.ts';
import { readConfig } from '../config.ts';
import { cellFixture } from '../../../collab/src/testing/database-cell-fixture.ts';
export type Reader = { cookie: string; user: string; session: string; workspace: string };
export async function databaseHttpFixture() {
  process.env.COLLAB_TEST_MIGRATIONS = resolve('packages/db/drizzle');
  const f = await cellFixture();
  process.env.DATABASE_URL = f.db.url;
  const config = readConfig(),
    app = await NestFactory.create<NestExpressApplication>(AppModule, {
      bodyParser: false,
      logger: false,
    });
  const durations = new Map<string, number>();
  app.use(
    (
      req: import('express').Request,
      res: import('express').Response,
      next: import('express').NextFunction,
    ) => {
      const key = req.headers['x-measure-id'],
        start = performance.now();
      res.on('finish', () => {
        if (typeof key === 'string') durations.set(key, performance.now() - start);
      });
      next();
    },
  );
  configureApplication(app);
  await app.listen(0, '127.0.0.1');
  const origin = await app.getUrl();
  const authentication = createAuth(app.get(DatabaseService).db, {
    origin: config.APP_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    sendVerificationEmail: async () => {},
  });
  async function account(role: 'owner' | 'member' | 'guest', grant = true): Promise<Reader> {
    const email = randomUUID() + '@example.test',
      password = randomBytes(22).toString('hex');
    const result = await authentication.api.signUpEmail({
      body: { email, password, name: 'Database reader' },
    });
    await f.db.pool.query('UPDATE auth_users SET email_verified=true WHERE id=$1', [
      result.user.id,
    ]);
    const response = await authentication.api.signInEmail({
      body: { email, password },
      asResponse: true,
    });
    assert.equal(response.status, 200);
    const cookie = response.headers
      .getSetCookie()
      .map((c) => c.split(';')[0])
      .join('; ');
    const verified = await authentication.api.getSession({ headers: new Headers({ cookie }) });
    assert(verified);
    const member = randomUUID(),
      subject = randomUUID();
    await f.db.pool.query(
      'INSERT INTO workspace_members(id,workspace_id,user_id,role) VALUES($1,$2,$3,$4)',
      [member, f.db.workspace, verified.user.id, role],
    );
    await f.db.pool.query("INSERT INTO actors(workspace_id,user_id,kind) VALUES($1,$2,'user')", [
      f.db.workspace,
      verified.user.id,
    ]);
    if (role === 'guest' && grant) {
      await f.db.pool.query(
        "INSERT INTO access_subjects(id,workspace_id,kind,member_id) VALUES($1,$2,'member',$3)",
        [subject, f.db.workspace, member],
      );
      await f.db.pool.query(
        "INSERT INTO access_grants(workspace_id,subject_id,resource_id,level,inherit) VALUES($1,$2,$3,'read',true)",
        [f.db.workspace, subject, f.containers[0]],
      );
    }
    return {
      cookie,
      user: verified.user.id,
      session: verified.session.id,
      workspace: f.db.workspace,
    };
  }
  const path = (base = f.bases[0]!, workspace = f.db.workspace) =>
    `/api/internal/workspaces/${workspace}/databases/${base}/query`;
  async function call(
    reader: Reader | undefined,
    body: unknown = {},
    route = path(),
    headers: Record<string, string> = {},
    method = 'POST',
  ) {
    const key = randomUUID(),
      start = performance.now();
    const response = await fetch(origin + route, {
      method,
      headers: {
        origin: config.APP_ORIGIN,
        'content-type': 'application/json',
        cookie: reader?.cookie ?? '',
        'x-measure-id': key,
        ...headers,
      },
      ...(method === 'GET' ? {} : { body: JSON.stringify(body) }),
    });
    const data = (await response.json()) as Record<string, unknown>;
    const roundTrip = performance.now() - start,
      server = durations.get(key);
    durations.delete(key);
    return { status: response.status, data, headers: response.headers, server: server!, roundTrip };
  }
  return {
    f,
    app,
    config,
    origin,
    account,
    call,
    path,
    service: app.get(DatabasesService),
    accountBucket: (r: Reader) =>
      throttleKey(config.BETTER_AUTH_SECRET, 'database:L:account', r.user),
    async close() {
      await app.close();
      await f.db.close();
    },
  };
}
