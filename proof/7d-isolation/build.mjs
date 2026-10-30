import { build, stop } from 'esbuild';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { createHash } from 'node:crypto';

const suite = process.argv[2] ?? 'transport';
if (!['transport', 'files-wire', 'files-mixed', 'recovery', 'capacity', 'cold'].includes(suite))
  throw Error('Unknown isolation suite');
const root = resolve('proof/7d-isolation'),
  out = resolve('apps/collab/dist');
const external = [
  'yjs',
  'y-protocols/*',
  'pg',
  'ws',
  '@hocuspocus/server',
  '@hocuspocus/provider',
  'better-auth',
  '@better-auth/passkey',
  '@nestjs/*',
  'reflect-metadata',
  'rxjs',
];
const patches = {};
function replace(text, before, after) {
  if (text.split(before).length !== 2)
    throw Error('Isolation source boundary changed: ' + before.slice(0, 65));
  return text.replace(before, after);
}
const plugin = {
  name: 'explicit-proof-only-source-adapter',
  setup(builder) {
    builder.onLoad(
      { filter: /[\\/]testing[\\/](files-mixed|cold|capacity)\.e2e\.ts$/ },
      async (args) => {
        let source = (await readFile(args.path, 'utf8')).replaceAll('\r\n', '\n');
        if (args.path.endsWith('files-mixed.e2e.ts')) {
          source = replace(
            source,
            "'.local/session-7-7d-mixed.json'",
            "'.local/isolation/mixed.json'",
          );
          source = replace(
            source,
            "diagnostic ? 'diagnostic-' : ''",
            "diagnostic ? 'diagnostic-' : 'isolation-'",
          );
          source = replace(
            source,
            '      diagnostic: diagnosticResult,',
            `      diagnostic: diagnosticResult,
      isolation: { publication: await host.hocus.metrics(), chargedBytes: host.memory.chargedBytes,
        fixedBytes: host.memory.fixedBytes, workerCount: host.validators.size },`,
          );
        } else {
          source =
            `import {admitProofMeasurement} from '${root.replaceAll('\\', '/')}/admission.mjs';\n` +
            source;
          if (args.path.endsWith('cold.e2e.ts')) {
            source = replace(
              source,
              "['content-1M', 'history-1M']",
              '[process.env.PROOF_PROFILE!]',
            );
            source = replace(
              source,
              '        const samples: number[] = [];',
              '        await admitProofMeasurement();\n        const samples: number[] = [];',
            );
            source = replace(
              source,
              "'.local/3a-cold-production.json'",
              'process.env.PROOF_OUTPUT!',
            );
            source = replace(
              source,
              '          profile,\n          memoryAfterPreparation:',
              '          profile,\n          publication: await host.hocus.metrics(),\n          memoryAfterPreparation:',
            );
          } else {
            source = replace(
              source,
              `    assert(
      freeBytes >= 3 * 1024 ** 3,
      'STOP: free RAM below 3 GiB; ask developer before measuring',
    );`,
              '    // The parent enforces the current Windows/WSL two-phase protocol.',
            );
            source = replace(
              source,
              "['content-200K', 'history-200K']",
              '[process.env.PROOF_PROFILE!]',
            );
            source = replace(
              source,
              '        fixture.destroy();\n        for (let i = 0;',
              '        fixture.destroy();\n        const publicationBaseline = await host.hocus.metrics();\n        await admitProofMeasurement();\n        for (let i = 0;',
            );
            source = replace(
              source,
              "'.local/3d-capacity-production.json'",
              'process.env.PROOF_OUTPUT!',
            );
            source = replace(
              source,
              '          profile,\n          pages: 30,',
              '          profile,\n          publicationBaseline,\n          publication: await host.hocus.metrics(),\n          pages: 30,',
            );
          }
        }
        return { contents: source, loader: 'ts', resolveDir: resolve(args.path, '..') };
      },
    );
    builder.onLoad({ filter: /[\\/]service[\\/](server|room)\.ts$/ }, async (args) => {
      const original = await readFile(args.path, 'utf8');
      let source = original.replaceAll('\r\n', '\n');
      if (args.path.endsWith('room.ts')) {
        source = replace(
          source,
          "import * as Y from 'yjs';",
          `import * as Y from 'yjs';\nimport { applyRemote } from '${root.replaceAll('\\', '/')}/remote-hocus.mjs';`,
        );
        source = replace(
          source,
          `    Y.applyUpdate(
      this.doc,
      loaded.updates.length
        ? Y.mergeUpdates([loaded.snapshot, ...loaded.updates])
        : loaded.snapshot,
    );`,
          `    await this.doc.load(loaded.snapshot, loaded.updates);`,
        );
        source = replace(
          source,
          '      Y.applyUpdate(this.doc, update);',
          '      await applyRemote(this.doc, update);',
        );
      } else {
        source = replace(
          source,
          "import { Hocuspocus } from '@hocuspocus/server';",
          `import { Hocuspocus } from '${root.replaceAll('\\', '/')}/remote-hocus.mjs';`,
        );
        source = replace(
          source,
          "import { removeAwarenessStates } from 'y-protocols/awareness';",
          `import { removeAwarenessStates } from '${root.replaceAll('\\', '/')}/remote-hocus.mjs';`,
        );
        source = replace(
          source,
          'Y.snapshotContainsUpdate(Y.snapshot(document), payload)',
          '(await document.containsUpdate(payload))',
        );
        source = replace(
          source,
          "if (!available) throw new CollaborationError('SERVICE_UNAVAILABLE', 503);",
          "if (!available || hocus.restarting) throw new CollaborationError('SERVICE_UNAVAILABLE', 503);",
        );
        source = replace(
          source,
          'if (!available || !rooms.has(documentName) || room.recovering) return;',
          'if (!available || !rooms.has(documentName) || room.recovering || hocus.restarting) return;',
        );
        source = replace(
          source,
          '  const memory = new ReplicaMemory(',
          `  await hocus.ready;
  hocus.onFailure = async () => {
    for (const room of rooms.values()) room.fatal = true;
    for (const room of rooms.values()) while (room.pending) await new Promise(r => setTimeout(r,10));
  };
  const memory = new ReplicaMemory(`,
        );
        source = replace(
          source,
          'poolReservation(config.COLLAB_VALIDATION_WORKERS),',
          'poolReservation(config.COLLAB_VALIDATION_WORKERS) + 32 * 1024 ** 2,',
        );
        source = replace(
          source,
          '    await leadership.close();\n    await validators.close();\n    throw error;',
          '    await leadership.close();\n    await validators.close();\n    await hocus.stopPublication();\n    throw error;',
        );
        source = replace(
          source,
          '      await leadership.close();\n    },',
          '      await leadership.close();\n      await hocus.stopPublication();\n    },',
        );
      }
      patches[args.path] = {
        originalSha256: createHash('sha256').update(original).digest('hex'),
        proofSha256: createHash('sha256').update(source).digest('hex'),
      };
      await mkdir('.local/isolation-source', { recursive: true });
      await writeFile(
        resolve(
          '.local/isolation-source',
          args.path.endsWith('room.ts') ? 'room.ts.txt' : 'server.ts.txt',
        ),
        source,
      );
      return { contents: source, loader: 'ts', resolveDir: resolve(args.path, '..') };
    });
  },
};
const options = {
  bundle: true,
  platform: 'node',
  target: 'node24',
  format: 'esm',
  sourcemap: true,
  external,
};
await build({
  ...options,
  entryPoints: ['apps/collab/src/service/incremental-worker.ts'],
  outfile: resolve(out, 'incremental-worker.mjs'),
});
await build({
  ...options,
  entryPoints: [resolve(root, 'publication-worker.mjs')],
  outfile: resolve(out, 'proof-publication-worker.mjs'),
});
await build({
  ...options,
  entryPoints: [
    ['transport', 'files-wire', 'files-mixed', 'capacity', 'cold'].includes(suite)
      ? `apps/collab/src/testing/${suite}.e2e.ts`
      : resolve(root, suite + '.mjs'),
  ],
  outfile: resolve(out, 'proof-isolation-' + suite + '.mjs'),
  plugins: [plugin],
});
stop();
await writeFile(
  '.local/isolation-source/patches.json',
  JSON.stringify({ suite, date: new Date().toISOString(), patches }, null, 2) + '\n',
);
console.log('Built isolated proof only: ' + suite);
