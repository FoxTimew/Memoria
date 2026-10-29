import express from 'express';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Pool, PoolClient } from 'pg';
import { FileReading, FileFault } from '@memoria/db';
import type { Database, FileReadClaim } from '@memoria/db';
import { consumeBucket, ipKey, throttleKey } from '@memoria/auth';
import { ReadTickets } from '@memoria/storage/read-ticket';
import type { S3ObjectStorage } from '@memoria/storage';
type Flow = {
  claim: FileReadClaim;
  abort: AbortController;
  last: number;
  checking: boolean;
  close: () => void;
};
const deadline = <T>(work: Promise<T>, ms = 1500) => {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<never>((_, reject) => {
      timer = setTimeout(() => reject(Error('FILE_CONTROL_TIMEOUT')), ms);
    }),
  ]).finally(() => clearTimeout(timer));
};
export function readRange(value: string | undefined, size: number) {
  if (value === undefined) return undefined;
  const m = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(value);
  if (!m || (!m[1] && !m[2])) throw Error('INVALID_RANGE');
  let start: number, end: number;
  if (!m[1]) {
    const suffix = Number(m[2]);
    if (!Number.isSafeInteger(suffix) || suffix < 1) throw Error('INVALID_RANGE');
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(m[1]);
    end = m[2] ? Math.min(size - 1, Number(m[2])) : size - 1;
  }
  if (
    !Number.isSafeInteger(start) ||
    !Number.isSafeInteger(end) ||
    start < 0 ||
    end < start ||
    start >= size
  )
    throw Error('INVALID_RANGE');
  return { start, end };
}
export async function fileGateway(options: {
  pool: Pool;
  db: Database;
  storage: S3ObjectStorage;
  secret: string;
  origin: string;
  trustedProxy: string[];
}) {
  const { pool, db, storage, secret, origin } = options,
    tickets = new ReadTickets(secret),
    reading = new FileReading(pool);
  const app = express();
  app.disable('x-powered-by');
  app.set('trust proxy', options.trustedProxy);
  const flows = new Set<Flow>(),
    accounts = new Map<string, number>();
  let pending = 0,
    ready = false,
    stopping = false,
    listener: PoolClient | undefined;
  const schema = (await pool.query('SELECT current_schema() s')).rows[0].s;
  const allClose = () => {
    ready = false;
    for (const flow of flows) flow.close();
  };
  const check = async (flow: Flow) => {
    if (flow.checking) return;
    flow.checking = true;
    try {
      await deadline(reading.authorize(flow.claim));
      flow.last = Date.now();
    } catch {
      flow.close();
    } finally {
      flow.checking = false;
    }
  };
  const notification = (n: { channel: string; payload?: string | undefined }) => {
    try {
      const p = JSON.parse(n.payload ?? '{}');
      if (p.schema !== schema) return;
    } catch {
      return;
    }
    for (const f of flows) void check(f);
  };
  const listenerError = () => {
    allClose();
  };
  try {
    listener = await pool.connect();
    listener.on('error', listenerError);
    listener.on('notification', notification);
    await listener.query('LISTEN memoria_collaboration; LISTEN memoria_files');
    ready = true;
  } catch (e) {
    listener?.release(true);
    throw e;
  }
  const watchdog = setInterval(() => {
    for (const f of flows) {
      if (Date.now() - f.last >= 3000) f.close();
      else void check(f);
    }
  }, 1000);
  // A query probe catches a half-open notification connection; all streams fail closed.
  let probing = false;
  const probe = setInterval(() => {
    if (probing || !listener || stopping) return;
    probing = true;
    void deadline(listener.query('SELECT 1'))
      .catch(allClose)
      .finally(() => {
        probing = false;
      });
  }, 1000);
  app.use((req, res, next) => {
    res.set({
      'Cache-Control': 'private, no-store',
      'Referrer-Policy': 'no-referrer',
      'X-Content-Type-Options': 'nosniff',
      'Content-Security-Policy': "sandbox; default-src 'none'; frame-ancestors 'none'",
      'X-Frame-Options': 'DENY',
      'Cross-Origin-Resource-Policy': 'same-site',
    });
    if (req.headers.origin === origin) {
      res.set('Access-Control-Allow-Origin', origin);
      res.vary('Origin');
      res.set(
        'Access-Control-Expose-Headers',
        'Content-Length, Content-Range, Content-Disposition',
      );
    }
    if (req.method === 'OPTIONS') {
      if (req.headers.origin !== origin) return void res.status(403).end();
      res
        .set('Access-Control-Allow-Methods', 'GET, HEAD')
        .set('Access-Control-Allow-Headers', 'Range')
        .status(204)
        .end();
      return;
    }
    next();
  });
  app.get('/health', (_req, res) => {
    res
      .status(ready && !stopping ? 200 : 503)
      .json({ status: ready && !stopping ? 'ok' : 'unavailable' });
  });
  app.all('/v1/files/:ticket', async (req, res) => {
    const error = (status: number, code: string) => {
      if (!res.headersSent && !res.destroyed) {
        res.removeHeader('Content-Length');
        res.removeHeader('Content-Disposition');
        res.status(status).type('application/json').end(JSON.stringify({ code }));
      } else res.destroy();
    };
    if (!['GET', 'HEAD'].includes(req.method)) {
      res.set('Allow', 'GET, HEAD');
      return error(405, 'METHOD_NOT_ALLOWED');
    }
    if (
      req.url.includes('?') ||
      req.headers['transfer-encoding'] ||
      (req.headers['content-length'] && req.headers['content-length'] !== '0')
    )
      return error(400, 'INVALID_FILE_REQUEST');
    if (!ready || stopping) return error(503, 'FILE_CONTROL_UNAVAILABLE');
    if (pending >= 32 || flows.size + pending >= 32) return error(429, 'FILE_STREAM_CAPACITY');
    pending++;
    let reserved = false,
      flow: Flow | undefined,
      timeout: ReturnType<typeof setTimeout> | undefined;
    const abort = new AbortController();
    const close = () => {
      abort.abort();
      res.destroy();
    };
    res.once('close', () => abort.abort());
    try {
      timeout = setTimeout(() => {
        abort.abort();
        error(503, 'FILE_CONTROL_UNAVAILABLE');
      }, 3500);
      const ip = await deadline(
        consumeBucket(db, ipKey(secret, 'file-download', req.ip ?? 'unknown'), 12000, 60),
      );
      if (!ip.allowed) {
        res.set('Retry-After', String(ip.retry));
        return error(429, 'FILE_RATE_LIMITED');
      }
      let claim: FileReadClaim;
      try {
        claim = tickets.open(String(req.params.ticket));
      } catch {
        return error(401, 'INVALID_FILE_TICKET');
      }
      for (const [scope, identity] of [
        ['account', claim.user],
        ['session', claim.session],
      ]) {
        const q = await deadline(
          consumeBucket(db, throttleKey(secret, 'file-download:' + scope, identity!), 240, 60),
        );
        if (!q.allowed) {
          res.set('Retry-After', String(q.retry));
          return error(429, 'FILE_RATE_LIMITED');
        }
      }
      if ((accounts.get(claim.user) ?? 0) >= 4) return error(429, 'FILE_STREAM_CAPACITY');
      accounts.set(claim.user, (accounts.get(claim.user) ?? 0) + 1);
      reserved = true;
      flow = { claim, abort, last: Date.now(), checking: false, close };
      const resource = await deadline(reading.authorize(claim));
      if (abort.signal.aborted || !ready || stopping) return error(503, 'FILE_CONTROL_UNAVAILABLE');
      let range;
      try {
        range = readRange(req.headers.range, resource.bytes);
      } catch {
        res.set('Content-Range', 'bytes */' + resource.bytes);
        return error(416, 'INVALID_RANGE');
      }
      res.set('Accept-Ranges', 'bytes');
      res.set('Content-Type', resource.mime);
      res.set(
        'Content-Disposition',
        (resource.inline ? 'inline' : 'attachment') +
          '; filename="asset"; filename*=UTF-8\'\'' +
          encodeURIComponent(resource.name).replace(
            /[!'()*]/g,
            (c) => '%' + c.charCodeAt(0).toString(16).toUpperCase(),
          ),
      );
      res.set('Content-Length', String(range ? range.end - range.start + 1 : resource.bytes));
      if (range) res.set('Content-Range', `bytes ${range.start}-${range.end}/${resource.bytes}`);
      res.status(range ? 206 : 200);
      if (req.method === 'HEAD') {
        res.end();
        return;
      }
      flows.add(flow);
      pending--;
      clearTimeout(timeout);
      timeout = undefined;
      const source = await storage.read(resource.key, range, abort.signal);
      // Backpressure and client/revocation abort propagate to the object-store request.
      await pipeline(Readable.from(source), res, { signal: abort.signal });
    } catch (e) {
      error(
        e instanceof FileFault ? 404 : 503,
        e instanceof FileFault ? 'FILE_UNAVAILABLE' : 'FILE_CONTROL_UNAVAILABLE',
      );
    } finally {
      if (timeout) clearTimeout(timeout);
      if (flow && flows.has(flow)) flows.delete(flow);
      else pending--;
      if (reserved && flow) {
        const n = (accounts.get(flow.claim.user) ?? 1) - 1;
        if (n) accounts.set(flow.claim.user, n);
        else accounts.delete(flow.claim.user);
      }
      abort.abort();
    }
  });
  app.use((_req, res) => {
    res.status(404).json({ code: 'NOT_FOUND' });
  });
  return {
    app,
    close: async () => {
      stopping = true;
      allClose();
      clearInterval(watchdog);
      clearInterval(probe);
      listener?.off('error', listenerError);
      listener?.off('notification', notification);
      await listener?.query('UNLISTEN *').catch(() => {});
      listener?.release(true);
      listener = undefined;
    },
    active: () => flows.size,
  };
}
