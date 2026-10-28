import { execFileSync, spawnSync } from 'node:child_process';
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  readFileSync,
  renameSync,
  writeFileSync,
} from 'node:fs';
import { join, resolve } from 'node:path';

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  if (configured.error || ![0, 1].includes(configured.status)) {
    throw new Error('Cannot inspect core.hooksPath; installation stopped.');
  }
  if (configured.status === 0) {
    throw new Error(
      'Custom core.hooksPath found; integrate these hooks explicitly, without overwriting it.',
    );
  }
  const hooksDir = resolve(
    execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim(),
  );
  const hooks = ['pre-commit', 'pre-push'].map((name) => {
    const destination = join(hooksDir, name);
    const source = readFileSync(join(root, '.githooks', name), 'utf8').replaceAll('\r\n', '\n');
    if (existsSync(destination)) {
      if (!lstatSync(destination).isFile())
        throw new Error(`Refusing to replace non-regular hook: ${name}`);
      const existing = readFileSync(destination, 'utf8');
      if (
        !existing.includes('# Memoria Git hook:') &&
        !existing.includes(`call_lefthook run "${name}"`)
      ) {
        throw new Error(`Custom ${name} hook found; installation stopped without replacing it.`);
      }
    }
    return { destination, source };
  });
  mkdirSync(hooksDir, { recursive: true });
  for (const { destination, source } of hooks) {
    const temporary = `${destination}.memoria-new`;
    writeFileSync(temporary, source, { flag: 'wx', mode: 0o755 });
    chmodSync(temporary, 0o755);
    renameSync(temporary, destination);
  }
  console.info(
    'Installed Memoria pre-commit and pre-push hooks. Existing unrelated hooks are preserved.',
  );
} catch (error) {
  console.error(`[hooks install] ${error.message}`);
  process.exitCode = 1;
}
