import { readFile, writeFile, unlink } from 'node:fs/promises';
import { createInterface } from 'node:readline/promises';
import pg from 'pg';
import { DatabaseCells, DatabaseFault } from '@memoria/db';
import { cellFixture } from './database-cell-fixture.ts';

// Local proof adapter, never an HTTP route; these IDs are not authentication tokens.
const path = '.local/session-6a-manual.json';
const [action, operation, kind, expected, ...words] = process.argv.slice(2);
type Context = {
  schema: string;
  workspace: string;
  database: string;
  row: string;
  properties: Record<string, string>;
  owner: { user: string; session: string; workspace: string };
  guest: { user: string; session: string; workspace: string };
  grant: string;
};
if (action === 'serve') {
  try {
    await readFile(path);
    throw new Error(
      'A proof context already exists; stop it first. If it crashed, inspect and remove only .local/session-6a-manual.json.',
    );
  } catch (e) {
    if ((e as { code?: string }).code !== 'ENOENT') throw e;
  }
  const f = await cellFixture();
  const context: Context = {
    schema: f.db.schema,
    workspace: f.db.workspace,
    database: f.bases[0]!,
    row: f.rows[0]!,
    properties: f.properties,
    owner: f.owner,
    guest: f.guest,
    grant: f.grant,
  };
  await writeFile(path, JSON.stringify(context, null, 2) + '\n');
  const input = createInterface({ input: process.stdin, output: process.stdout });
  try {
    await input.question(
      'Fixture ready. Use two other terminals as owner/guest. Press Enter AFTER closing the clients to remove this fixture.\n',
    );
  } finally {
    input.close();
    await unlink(path);
    await f.db.close();
  }
} else {
  const context = JSON.parse(await readFile(path, 'utf8')) as Context;
  const base = process.env.DATABASE_URL;
  if (
    !base ||
    process.env.NODE_ENV === 'production' ||
    !['localhost', '127.0.0.1', '[::1]'].includes(new URL(base).hostname) ||
    !/^memoria_collab_test_[a-f0-9]{32}$/.test(context.schema)
  )
    throw new Error('Local isolated test schema required');
  const url = new URL(base);
  url.searchParams.set('options', '-c search_path=' + context.schema);
  const pool = new pg.Pool({ connectionString: url.toString(), max: 1, query_timeout: 10000 });
  try {
    if (action === 'grant' && ['read', 'edit', 'none'].includes(operation ?? '')) {
      // Operator fixture control, not an application permission endpoint.
      await pool.query(
        'UPDATE access_grants SET level=$1,deleted_at=CASE WHEN $2 THEN now() ELSE NULL END WHERE id=$3',
        [operation === 'none' ? 'read' : operation, operation === 'none', context.grant],
      );
      console.log('Fixture guest grant:', operation);
    } else {
      if (
        !['owner', 'guest'].includes(action ?? '') ||
        !['read', 'write'].includes(operation ?? '') ||
        !kind ||
        !context.properties[kind]
      )
        throw new Error(
          'Usage: owner|guest read TYPE, or owner|guest write TYPE VERSION VALUE; value JSON except text/url/number',
        );
      const cells = new DatabaseCells(pool),
        subject = action === 'owner' ? context.owner : context.guest;
      const address = {
        database: context.database,
        row: context.row,
        property: context.properties[kind]!,
      };
      const result =
        operation === 'read'
          ? await cells.read(subject, address)
          : await cells.write(subject, {
              ...address,
              expectedCellVersion: expected!,
              expectedSchemaVersion: '1',
              value: ['text', 'url', 'number'].includes(kind)
                ? words.join(' ')
                : JSON.parse(words.join(' ')),
            });
      console.log(JSON.stringify(result, null, 2));
    }
  } catch (e) {
    if (e instanceof DatabaseFault) {
      console.log(JSON.stringify({ status: e.status, code: e.code, current: e.current }, null, 2));
      process.exitCode = 1;
    } else throw e;
  } finally {
    await pool.end();
  }
}
