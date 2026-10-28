import { execFileSync, spawnSync } from 'node:child_process';
import { lstatSync } from 'node:fs';

function git(args) {
  return execFileSync('git', args, { encoding: 'utf8', maxBuffer: 20 * 1024 * 1024 });
}

function run(label, args) {
  console.info(`[git hook] ${label}`);
  const result = spawnSync(process.execPath, args, { stdio: ['ignore', 'inherit', 'inherit'] });
  if (result.error || result.signal || result.status !== 0) {
    console.error(`[git hook] ${label} failed; operation blocked.`);
    if (result.error) console.error(result.error.message);
    process.exit(result.status || 1);
  }
}

// Keep arguments below Windows process limits; never pass filenames through a shell.
function batches(files) {
  const result = [];
  let batch = [];
  let length = 0;
  for (const file of files) {
    if (batch.length && length + file.length + 3 > 6000) {
      result.push(batch);
      batch = [];
      length = 0;
    }
    batch.push(file);
    length += file.length + 3;
  }
  if (batch.length) result.push(batch);
  return result;
}

function preCommit() {
  run('staged secrets', ['scripts/check-staged.mjs']);
  const files = git(['diff', '--cached', '--name-only', '--diff-filter=ACMR', '-z'])
    .split('\0')
    .filter(Boolean);
  const unstaged = new Set(git(['diff', '--name-only', '-z']).split('\0'));
  const partial = files.filter((file) => unstaged.has(file));
  if (partial.length) {
    throw new Error(
      `Partially staged files: review and stage the intended complete files before automatic fixes.\n${partial.join('\n')}`,
    );
  }
  for (const file of files) {
    if (!lstatSync(file).isFile()) throw new Error(`Non-regular staged path: ${file}`);
  }
  for (const batch of batches(files.filter((file) => /\.(?:m?js|tsx?)$/.test(file)))) {
    run('staged lint', [
      'node_modules/eslint/bin/eslint.js',
      '--fix',
      '--max-warnings=0',
      '--',
      ...batch,
    ]);
  }
  for (const batch of batches(files)) {
    run('staged format', [
      'node_modules/prettier/bin/prettier.cjs',
      '--write',
      '--ignore-unknown',
      '--',
      ...batch,
    ]);
  }
  for (const batch of batches(files)) git(['add', '--', ...batch]);
  // Check the actual index again after automatic fixes have been staged.
  run('staged secrets after fixes', ['scripts/check-staged.mjs']);
}

function prePush() {
  run('typecheck', ['scripts/typecheck.mjs']);
  run('Nest build', ['scripts/build-server.mjs', 'api', '--probe']);
  run('Nest probe', ['apps/api/dist/bootstrap-probe.mjs']);
  run('tests', ['node_modules/vitest/vitest.mjs', 'run', '--passWithNoTests']);
}

try {
  process.chdir(git(['rev-parse', '--show-toplevel']).trim());
  const hook = process.argv[2];
  if (hook === 'pre-commit') preCommit();
  else if (hook === 'pre-push') prePush();
  else throw new Error(`Unsupported hook: ${hook}`);
} catch (error) {
  console.error(`[git hook] ${error.message}`);
  process.exitCode = 1;
}
