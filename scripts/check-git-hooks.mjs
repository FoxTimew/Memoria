import { execFileSync, spawnSync } from 'node:child_process';
import { accessSync, constants, lstatSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';

try {
  const root = execFileSync('git', ['rev-parse', '--show-toplevel'], { encoding: 'utf8' }).trim();
  process.chdir(root);
  const configured = spawnSync('git', ['config', '--get', 'core.hooksPath'], { encoding: 'utf8' });
  if (configured.error || configured.status !== 1) {
    throw new Error('core.hooksPath personnalisé ou impossible à vérifier.');
  }
  const directory = resolve(
    execFileSync('git', ['rev-parse', '--git-path', 'hooks'], { encoding: 'utf8' }).trim(),
  );
  for (const name of ['pre-commit', 'pre-push']) {
    const installed = join(directory, name);
    if (!lstatSync(installed).isFile()) throw new Error(`${name} non régulier.`);
    const actual = readFileSync(installed, 'utf8').replaceAll('\r\n', '\n');
    const expected = readFileSync(join(root, '.githooks', name), 'utf8').replaceAll('\r\n', '\n');
    if (actual !== expected) throw new Error(`${name} absent, modifié ou obsolète.`);
    if (process.platform !== 'win32') accessSync(installed, constants.X_OK);
  }
  console.info('Hooks Memoria installés et à jour dans ce clone.');
} catch (error) {
  console.error(
    `Hooks Memoria manquants ou non conformes. Lance pnpm hooks:install.\n${error.message}`,
  );
  process.exitCode = 1;
}
