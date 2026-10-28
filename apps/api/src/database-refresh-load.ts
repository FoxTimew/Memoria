import 'reflect-metadata';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { fork, execFileSync, spawn } from 'node:child_process';
import { readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { setTimeout as delay } from 'node:timers/promises';
import { performance } from 'node:perf_hooks';
import { NestFactory } from '@nestjs/core';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { Request, Response, NextFunction } from 'express';
import { createAuth } from '@memoria/auth';
import { collaborationRowAccessSchema, presenceUser } from '@memoria/contracts';
import { prepareMeasurement, runMeasuredSeries } from '../../../scripts/measurement-memory.mjs';
import { parseContainerStats } from '../../../scripts/measurement-container.mjs';
import { AppModule, configureApplication } from './app.ts';
import { DatabaseService } from './database.module.ts';
import { readConfig } from './config.ts';
import { databaseHttpFixture } from './testing/database-http-fixture.ts';
import type { Reader } from './testing/database-http-fixture.ts';
import { fillTableFixture } from './testing/database-table-fixture.ts';
import { collaborationServer, sessionVerifier } from '../../collab/src/service/server.ts';
import { readCollabConfig } from '../../collab/src/service/config.ts';
import { caddyFixture } from '../../collab/src/testing/caddy-fixture.ts';
import { nativeRowClient } from '../../collab/src/testing/native-row-client.ts';

const p95 = (values: number[]) =>
  [...values].sort((a, b) => a - b)[Math.ceil(values.length * 0.95) - 1] ?? 0;
type ServerMessage =
  | { type: 'ready'; origin: string; collabPort: number }
  | { type: 'response'; key: string; ms: number; path: string; status: number }
  | {
      type: 'load';
      cpuCores: number;
      rss: number;
      eventLoop: number;
      rooms: number;
      chargedBytes: number;
      poolWaiting: number;
    };
// Separate process: server CPU/RSS excludes the load generator and request bookkeeping.
if (process.argv.includes('--refresh-server')) {
  const app = await NestFactory.create<NestExpressApplication>(AppModule, {
    bodyParser: false,
    logger: false,
  });
  app.use((req: Request, res: Response, next: NextFunction) => {
    const start = performance.now(),
      key = req.headers['x-measure-id'];
    res.on('finish', () => {
      if (typeof key === 'string')
        process.send?.({
          type: 'response',
          key,
          ms: performance.now() - start,
          path: req.route?.path ?? req.path,
          status: res.statusCode,
        });
    });
    next();
  });
  configureApplication(app);
  await app.listen(0, '127.0.0.1');
  const db = app.get(DatabaseService),
    config = readConfig();
  const auth = createAuth(db.db, {
    origin: config.APP_ORIGIN,
    secret: config.BETTER_AUTH_SECRET,
    sendVerificationEmail: async () => {},
  });
  const host = await collaborationServer(
    readCollabConfig({
      ...process.env,
      COLLAB_HOST: '0.0.0.0',
      COLLAB_PORT: '0',
      COLLAB_INTERNAL_PORT: '0',
    }),
    db.pool,
    sessionVerifier(auth),
  );
  process.env.COLLAB_INTERNAL_URL = host.internal.url;
  let cpu = process.cpuUsage(),
    time = performance.now(),
    elu = performance.eventLoopUtilization();
  const timer = setInterval(() => {
    const now = performance.now(),
      current = process.cpuUsage(),
      currentElu = performance.eventLoopUtilization();
    process.send?.({
      type: 'load',
      cpuCores: (current.user - cpu.user + current.system - cpu.system) / 1000 / (now - time),
      rss: process.memoryUsage().rss,
      eventLoop: performance.eventLoopUtilization(currentElu, elu).utilization,
      rooms: host.rooms.size,
      chargedBytes: host.memory.chargedBytes,
      poolWaiting: db.pool.waitingCount,
    });
    cpu = current;
    time = now;
    elu = currentElu;
  }, 1000);
  process.on('message', (m) => {
    if (m === 'close')
      void (async () => {
        clearInterval(timer);
        await host.close();
        await app.close();
        process.disconnect?.();
      })();
  });
  process.send?.({
    type: 'ready',
    origin: await app.getUrl(),
    collabPort: Number(new URL(host.ingress.url).port),
  });
} else {
  const preparation = await prepareMeasurement('database-refresh-50');
  const oracle = JSON.parse(await readFile('.local/session-6d-refresh-oracle.json', 'utf8')) as {
    requests: { tab: string; method: string; path: string; status: number }[];
    durationMs: number;
  };
  assert(oracle.durationMs >= 65000 && oracle.requests.every((r) => r.status === 200));
  const expected = [
    ['table', 'GET', '/api/auth/security/cache-policy', 17],
    ['row', 'GET', '/api/auth/security/cache-policy', 17],
    ['table', 'POST', '/api/internal/workspaces/:workspace/row-access', 17],
    ['row', 'POST', '/api/internal/workspaces/:workspace/row-access', 17],
    ['table', 'GET', '/api/internal/workspaces/:workspace/databases/:database', 4],
    ['row', 'GET', '/api/internal/workspaces/:workspace/databases/:database', 4],
    ['table', 'POST', '/api/internal/workspaces/:workspace/databases/:database/query', 4],
    ['row', 'GET', '/api/internal/workspaces/:workspace/databases/:database/rows/:row', 4],
  ] as const;
  for (const [tab, method, path, count] of expected)
    assert.equal(
      oracle.requests.filter((r) => r.tab === tab && r.method === method && r.path === path).length,
      count,
      'UI wire oracle changed; inspect before replaying a different schedule',
    );
  assert.equal(oracle.requests.length, 84);
  process.env.TRUSTED_PROXY_CIDRS = '10.255.255.0/24';
  const h = await databaseHttpFixture(),
    { f } = h;
  const reports: unknown[] = [],
    diagnostics: unknown[] = [];
  let child: ReturnType<typeof fork> | undefined,
    proxy: Awaited<ReturnType<typeof caddyFixture>> | undefined;
  const clients: Awaited<ReturnType<typeof nativeRowClient>>[] = [];
  const output = '.local/session-6d-refresh-load.json';
  let ready: Extract<ServerMessage, { type: 'ready' }>;
  let measured = false;
  let serverSamples: { key: string; ms: number; path: string; status: number }[] = [],
    loads: Extract<ServerMessage, { type: 'load' }>[] = [];
  const save = () =>
    writeFile(
      output,
      JSON.stringify(
        {
          source: execFileSync('git', ['rev-parse', 'HEAD'], {
            encoding: 'utf8',
            windowsHide: true,
          }).trim(),
          protocol:
            '3 x 600 seconds; 50 distinct authenticated accounts behind one untrusted HTTP IP, each with a virtual visible table tab and native WSS row tab. Production routes/guards/quotas/admission unchanged; real 65s final-UI oracle. Cadences 4s/cache per tab, 15s/table/base/title, deterministic distributed phases; one persisted row per account. Separate server process; default four workers and 1 GiB budget. Driver simulates network work, not rendering or browser RAM.',
          preparation,
          oracle,
          reports,
          diagnostics,
        },
        null,
        2,
      ) + '\n',
    );
  try {
    await fillTableFixture(f);
    const readers: Reader[] = [];
    for (let i = 0; i < 50; i++) readers.push(await h.account(i === 0 ? 'owner' : 'member'));
    const rows = (
      await f.db.pool.query<{ id: string }>(
        'SELECT page_id id FROM database_rows WHERE database_id=$1 AND deleted_at IS NULL ORDER BY page_id LIMIT 50',
        [f.bases[0]],
      )
    ).rows.map((r) => r.id);
    child = fork(fileURLToPath(import.meta.url), ['--refresh-server'], {
      env: { ...process.env, DATABASE_URL: f.db.url },
      execArgv: [],
      stdio: ['ignore', 'pipe', 'pipe', 'ipc'],
      windowsHide: true,
    });
    child.stderr?.on('data', (b) => diagnostics.push({ serverError: b.toString() }));
    ready = await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('SERVER_START_TIMEOUT')), 30000);
      child!.on('exit', (code) => {
        clearTimeout(timer);
        reject(new Error('SERVER_EXIT_' + code));
      });
      child!.on('message', (value) => {
        const m = value as ServerMessage;
        if (m.type === 'ready') {
          clearTimeout(timer);
          resolve(m);
        } else if (measured && m.type === 'response') serverSamples.push(m);
        else if (measured && m.type === 'load') loads.push(m);
      });
    });
    proxy = await caddyFixture(ready.collabPort);
    const W = `/api/internal/workspaces/${f.db.workspace}`,
      B = `${W}/databases/${f.bases[0]}`;
    const request = async (reader: Reader, path: string, method = 'GET', body?: unknown) => {
      const key = randomUUID(),
        started = performance.now();
      const response = await fetch(ready.origin + path, {
        method,
        headers: {
          cookie: reader.cookie,
          origin: h.config.APP_ORIGIN,
          'content-type': 'application/json',
          'x-measure-id': key,
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
        signal: AbortSignal.timeout(10000),
      });
      const data = (await response.json()) as Record<string, unknown>;
      return { key, status: response.status, ms: performance.now() - started, data };
    };
    for (let i = 0; i < 50; i++) {
      const r = await request(readers[i]!, `${B}/rows/${rows[i]}/collaboration`, 'POST', {});
      assert.equal(r.status, 200, `Room preparation ${i}: ${JSON.stringify(r.data)}`);
      const meta = collaborationRowAccessSchema.parse(r.data);
      const client = await nativeRowClient(
        proxy.url,
        proxy.ca,
        readers[i]!.cookie,
        h.config.APP_ORIGIN,
        meta.room,
        { ...meta.identity, scope: 'database-row', rowScope: meta.rowScope },
        presenceUser(readers[i]!.user, 'Load account ' + i),
      );
      assert(!client.closed());
      clients.push(client);
      assert.equal(
        (
          await request(readers[i]!, `${W}/row-access`, 'POST', {
            rows: [{ database: f.bases[0], row: rows[i] }],
          })
        ).status,
        200,
      );
    }
    for (let series = 1; series <= 3; series++) {
      const { result, hygiene } = await runMeasuredSeries(
        `database-refresh-50-${series}`,
        async () => {
          serverSamples = [];
          loads = [];
          measured = true;
          const started = performance.now(),
            durationMs = 600000;
          const responses: {
            account: number;
            tab: string;
            kind: string;
            key: string;
            status: number;
            ms: number;
            elapsedMs: number;
            code?: unknown;
          }[] = [];
          const postgres: unknown[] = [];
          const pgId = execFileSync('docker', ['compose', 'ps', '-q', 'postgres'], {
            encoding: 'utf8',
            windowsHide: true,
          }).trim();
          const pgStats = spawn('docker', ['stats', '--format', '{{json .}}', pgId], {
            windowsHide: true,
            stdio: ['ignore', 'pipe', 'pipe'],
          });
          let pgBuffer = '';
          pgStats.stdout.on('data', (chunk) => {
            pgBuffer += chunk.toString();
            let index;
            while ((index = pgBuffer.indexOf('\n')) >= 0) {
              const line = pgBuffer.slice(0, index);
              pgBuffer = pgBuffer.slice(index + 1);
              try {
                const value = parseContainerStats(line);
                if (!value) continue;
                postgres.push({
                  elapsedMs: performance.now() - started,
                  ...value,
                });
              } catch {
                failure ??= 'INVALID_POSTGRES_TELEMETRY';
              }
            }
          });
          const jobs: Promise<void>[] = [];
          const skipped: Record<string, number> = {};
          let failure: string | undefined;
          const call = async (
            index: number,
            tab: string,
            kind: string,
            path: string,
            method = 'GET',
            body?: unknown,
          ) => {
            if (failure) return;
            try {
              const r = await request(readers[index]!, path, method, body);
              responses.push({
                account: index,
                tab,
                kind,
                key: r.key,
                status: r.status,
                ms: r.ms,
                elapsedMs: performance.now() - started,
                ...(r.status === 200 ? {} : { code: r.data.code }),
              });
              if (r.status !== 200) failure = `HTTP_${r.status}_${kind}`;
            } catch (e) {
              failure = e instanceof Error ? e.message : 'REQUEST_FAILED';
            }
          };
          const schedule = (
            index: number,
            tab: string,
            kind: string,
            period: number,
            phase: number,
            work: () => Promise<void>,
          ) => {
            jobs.push(
              (async () => {
                let tick = phase;
                while (!failure && tick < durationMs) {
                  await delay(Math.max(0, started + tick - performance.now()));
                  if (failure) break;
                  await work();
                  tick += period;
                  while (tick < performance.now() - started) {
                    skipped[kind] = (skipped[kind] ?? 0) + 1;
                    tick += period;
                  }
                }
              })(),
            );
          };
          for (let i = 0; i < 50; i++) {
            for (const [tab, offset] of [
              ['table', 0],
              ['row', 2000],
            ] as const)
              schedule(i, tab, 'cache', 4000, (i * 80 + offset) % 4000, async () => {
                await call(i, tab, 'cache-policy', '/api/auth/security/cache-policy');
                await call(i, tab, 'row-access', `${W}/row-access`, 'POST', {
                  rows: [{ database: f.bases[0], row: rows[i] }],
                });
              });
            schedule(i, 'table', 'table', 15000, i * 300, async () => {
              await call(i, 'table', 'base', B);
              await call(i, 'table', 'query', B + '/query', 'POST', {
                filters: [],
                sorts: [],
                pageSize: 50,
              });
            });
            schedule(i, 'row', 'base', 15000, (i * 300 + 5000) % 15000, () =>
              call(i, 'row', 'base', B),
            );
            schedule(i, 'row', 'title', 15000, (i * 300 + 10000) % 15000, () =>
              call(i, 'row', 'title', `${B}/rows/${rows[i]}`),
            );
          }
          const telemetry = setInterval(() => {
            if (!postgres.length) failure ??= 'POSTGRES_TELEMETRY_MISSING';
            if (clients.some((c) => c.closed())) failure ??= 'WSS_CLOSED';
            const query = serverSamples.filter((r) => r.path.endsWith('/query')).map((r) => r.ms);
            if (query.length >= 100 && p95(query) >= 200) failure ??= 'TABLE_P95_OVER_200_MS';
            console.log(
              JSON.stringify({
                series,
                seconds: Math.round((performance.now() - started) / 1000),
                responses: responses.length,
                statuses: responses.reduce(
                  (out, r) => {
                    out[r.status] = (out[r.status] ?? 0) + 1;
                    return out;
                  },
                  {} as Record<string, number>,
                ),
                queryP95: p95(query),
                cpuCores: loads.at(-1)?.cpuCores,
                failure,
              }),
            );
          }, 30000);
          try {
            await Promise.all(jobs);
            if (!failure) await delay(Math.max(0, started + durationMs - performance.now()));
          } finally {
            clearInterval(telemetry);
            pgStats.kill();
            await delay(50);
            measured = false;
          }
          if (!postgres.length) failure ??= 'POSTGRES_TELEMETRY_MISSING';
          const result = {
            durationMs: performance.now() - started,
            responses,
            serverSamples,
            loads,
            postgres,
            skipped,
            failure: failure ?? null,
            queryP95: p95(serverSamples.filter((r) => r.path.endsWith('/query')).map((r) => r.ms)),
          };
          return result;
        },
        { preparation },
      );
      reports.push({ series, hygiene, ...result });
      await save();
      if (result.failure) throw new Error(result.failure);
      assert(result.durationMs >= 600000);
      assert.equal(result.responses.filter((r) => r.status === 429).length, 0);
    }
  } catch (e) {
    diagnostics.push({ stopped: e instanceof Error ? e.message : String(e) });
    await save();
    throw e;
  } finally {
    for (const c of clients) c.close();
    proxy?.close();
    if (child) {
      child.send('close');
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child!.kill();
          resolve();
        }, 10000);
        child!.once('exit', () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    await h.close();
  }
}
