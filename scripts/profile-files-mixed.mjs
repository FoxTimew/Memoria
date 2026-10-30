import { mkdir, writeFile, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { cpus } from 'node:os';
const output = resolve('.local/mixed-profile', new Date().toISOString().replaceAll(/[:.]/g, '-'));
await mkdir(output, { recursive: true });
const sources = [
  'apps/collab/src/testing/files-mixed.e2e.ts',
  'apps/collab/src/testing/mixed-profile.ts',
  'scripts/mixed-sql-observer.mjs',
  'apps/collab/src/service/validation-pool.ts',
  'apps/collab/src/service/projection.ts',
  'apps/collab/src/service/store.ts',
];
await writeFile(
  resolve(output, 'manifest.json'),
  JSON.stringify(
    {
      date: new Date().toISOString(),
      diagnosticOnly: true,
      node: process.version,
      cpu: cpus()[0]?.model,
      commit: execFileSync('git', ['rev-parse', 'HEAD'], {
        encoding: 'utf8',
        windowsHide: true,
      }).trim(),
      sources: Object.fromEntries(
        await Promise.all(
          sources.map(async (p) => [
            p,
            createHash('sha256')
              .update(await readFile(p))
              .digest('hex'),
          ]),
        ),
      ),
      protocol:
        'Three diagnostic series of the unchanged history + 8K conversions workload, ten independent clients. CPU/pool/main-loop/SQL observers enabled. Latencies are diagnostic, never qualification; existing thresholds recorded, connection/resource failures still stop. Power/memory/swap guards unchanged.',
    },
    null,
    2,
  ) + '\n',
);
console.log(JSON.stringify({ output }));
const child = spawn(process.execPath, ['scripts/test-collab.mjs', '--suite', 'files-mixed'], {
  windowsHide: true,
  stdio: 'inherit',
  env: { ...process.env, MEMORIA_MIXED_DIAGNOSTIC_DIR: output },
});
child.on('error', () => {
  process.exitCode = 1;
});
child.on('exit', (code) => {
  process.exitCode = code ?? 1;
});
