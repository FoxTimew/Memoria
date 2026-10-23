import { createServer } from 'node:http';
import { once } from 'node:events';
import type { Pool } from 'pg';
import { verifyInternalSignature } from '@memoria/auth/collaboration';
import { collaborationCommandSchema } from '@memoria/contracts';
import type { CollaborationCommand } from '@memoria/contracts';
import type { CollabConfig } from './config.ts';
export class CollaborationError extends Error {
  constructor(
    readonly code: string,
    readonly status = 409,
    readonly details: object = {},
  ) {
    super(code);
  }
}
export async function createInternalServer(
  config: CollabConfig,
  pool: Pool,
  execute: (command: CollaborationCommand) => Promise<unknown>,
) {
  let pending = 0;
  const server = createServer((req, res) => {
    const respond = (status: number, body: object) => {
      if (!res.writableEnded) {
        res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
        res.end(JSON.stringify(body));
      }
    };
    if (req.method !== 'POST' || req.url !== '/internal/collaboration' || req.headers.origin) {
      respond(404, { code: 'NOT_FOUND' });
      return;
    }
    if (pending >= 32) {
      respond(503, { code: 'INTERNAL_CAPACITY' });
      req.resume();
      return;
    }
    pending++;
    let size = 0;
    const chunks: Buffer[] = [];
    const timer = setTimeout(() => {
      respond(408, { code: 'REQUEST_TIMEOUT' });
      req.destroy();
    }, 5000);
    req.on('data', (chunk: Buffer) => {
      size += chunk.length;
      if (size > 1048576 + 65536) {
        respond(413, { code: 'COMMAND_TOO_LARGE' });
        req.destroy();
      } else chunks.push(chunk);
    });
    req.once('close', () => clearTimeout(timer));
    req.once('error', () => {});
    let ended = false;
    req.once('close', () => {
      if (!ended) pending--;
    });
    req.on('end', () => {
      ended = true;
      clearTimeout(timer);
      void (async () => {
        try {
          const body = Buffer.concat(chunks).toString('utf8'),
            headers = Object.fromEntries(
              ['x-memoria-time', 'x-memoria-nonce', 'x-memoria-signature'].map((key) => [
                key,
                typeof req.headers[key] === 'string' ? req.headers[key] : undefined,
              ]),
            );
          const nonce = verifyInternalSignature(
            config.COLLAB_INTERNAL_SECRET,
            req.url!,
            body,
            headers,
          );
          await pool.query('DELETE FROM collaboration_nonces WHERE expires_at<clock_timestamp()');
          const admitted = await pool.query(
            "INSERT INTO collaboration_nonces(nonce,expires_at) VALUES($1,clock_timestamp()+interval '60 seconds') ON CONFLICT DO NOTHING RETURNING nonce",
            [nonce],
          );
          if (admitted.rowCount !== 1) throw new Error('INTERNAL_AUTH_DENIED');
          const parsed = collaborationCommandSchema.safeParse(JSON.parse(body));
          if (!parsed.success) throw new CollaborationError('INVALID_COMMAND', 400);
          const result = await execute(parsed.data);
          respond(200, result as object);
        } catch (error) {
          if (error instanceof CollaborationError)
            respond(error.status, { code: error.code, ...error.details });
          else if (error instanceof Error && error.message === 'INTERNAL_AUTH_DENIED')
            respond(401, { code: 'INTERNAL_AUTH_DENIED' });
          else if (error instanceof SyntaxError) respond(400, { code: 'INVALID_JSON' });
          else respond(503, { code: 'COLLAB_UNAVAILABLE' });
        } finally {
          pending--;
        }
      })();
    });
  });
  server.requestTimeout = 5000;
  server.headersTimeout = 5000;
  server.listen(config.COLLAB_INTERNAL_PORT, config.COLLAB_INTERNAL_HOST);
  await once(server, 'listening');
  return {
    server,
    get url() {
      const address = server.address();
      if (!address || typeof address === 'string') throw new Error('Not listening');
      return `http://${config.COLLAB_INTERNAL_HOST}:${address.port}/internal/collaboration`;
    },
    async close() {
      server.closeIdleConnections();
      await new Promise<void>((resolve) => server.close(() => resolve()));
    },
  };
}
