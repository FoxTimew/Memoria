import { createDatabase } from '@memoria/db';
import { createAuth } from '@memoria/auth';
import { readCollabConfig } from './service/config.ts';
import { collaborationServer, sessionVerifier } from './service/server.ts';
const config = readCollabConfig();
const { db, pool } = createDatabase(config.DATABASE_URL, { pipeline: true });
const auth = createAuth(db, {
  origin: config.APP_ORIGIN,
  secret: config.BETTER_AUTH_SECRET,
  sendVerificationEmail: async () => {
    throw new Error('Collaboration only verifies existing sessions');
  },
});
const server = await collaborationServer(config, pool, sessionVerifier(auth));
console.log(`Collaboration listening on ${config.COLLAB_HOST}:${config.COLLAB_PORT}`);
let closing = false;
for (const signal of ['SIGTERM', 'SIGINT'])
  process.once(signal, () => {
    if (closing) return;
    closing = true;
    void server
      .close()
      .then(() => pool.end())
      .catch(() => {
        process.exitCode = 1;
      });
  });
