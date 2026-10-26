import { afterEach, describe, expect, it } from 'vitest';
import { spawnSync } from 'node:child_process';
import {
  copyFileSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const sourceRoot = fileURLToPath(new URL('../', import.meta.url));
const testRoot = join(sourceRoot, '.local', 'git-hook-tests');
const fixtures = [];

function write(root, file, text) {
  const target = join(root, file);
  mkdirSync(dirname(target), { recursive: true });
  writeFileSync(target, text);
}

function command(root, executable, args) {
  // Git exports repository-local variables to hooks. Nested test repositories must not inherit them.
  const env = Object.fromEntries(
    Object.entries(process.env).filter(([key]) => !/^GIT_/i.test(key)),
  );
  env.GIT_CONFIG_NOSYSTEM = '1';
  env.GIT_CONFIG_GLOBAL = join(root, '.test-global-config');
  return spawnSync(executable, args, {
    cwd: root,
    env,
    encoding: 'utf8',
    timeout: 30_000,
    maxBuffer: 4 * 1024 * 1024,
  });
}

function ok(result) {
  expect(result.error, result.error?.message).toBeUndefined();
  expect(result.status, `${result.stdout}\n${result.stderr}`).toBe(0);
  return result.stdout.trim();
}

function git(root, ...args) {
  return command(root, 'git', args);
}

function instrument(stage) {
  // Only the fixture's expensive pre-push tools are replaced. Production has no test/skip switch.
  return `import fs from 'node:fs';
fs.appendFileSync('.test-calls', JSON.stringify({ stage: ${JSON.stringify(stage)}, args: process.argv.slice(2) }) + '\\n');
if (fs.existsSync('.test-failure') && fs.readFileSync('.test-failure', 'utf8') === ${JSON.stringify(stage)}) process.exit(37);
`;
}

function fixture() {
  mkdirSync(testRoot, { recursive: true });
  const root = mkdtempSync(join(testRoot, 'case-'));
  fixtures.push(root);
  ok(git(root, 'init', '-b', 'main'));
  ok(git(root, 'config', 'user.name', 'Memoria hook test'));
  ok(git(root, 'config', 'user.email', 'hooks@example.invalid'));
  ok(git(root, 'config', 'commit.gpgsign', 'false'));
  ok(git(root, 'config', 'core.autocrlf', 'false'));
  write(root, '.test-global-config', '');
  for (const file of ['git-hooks.mjs', 'install-git-hooks.mjs', 'check-staged.mjs']) {
    mkdirSync(join(root, 'scripts'), { recursive: true });
    copyFileSync(join(sourceRoot, 'scripts', file), join(root, 'scripts', file));
  }
  for (const name of ['pre-commit', 'pre-push']) {
    write(root, `.githooks/${name}`, readFileSync(join(sourceRoot, '.githooks', name)));
  }
  // ESLint and Prettier are the real installed validators, invoked in this isolated repository.
  for (const [packageName, bin] of [
    ['eslint', 'bin/eslint.js'],
    ['prettier', 'bin/prettier.cjs'],
  ]) {
    write(root, `node_modules/${packageName}/package.json`, '{"type":"commonjs"}');
    write(
      root,
      `node_modules/${packageName}/${bin}`,
      `const { spawnSync } = require('node:child_process');
const result = spawnSync(process.execPath, [${JSON.stringify(join(sourceRoot, 'node_modules', packageName, bin))}, ...process.argv.slice(2)], { stdio: 'inherit' });
process.exit(result.status ?? 1);
`,
    );
  }
  write(root, 'eslint.config.mjs', "export default [{rules:{'no-debugger':'error'}}];\n");
  write(root, 'node_modules/turbo/package.json', '{"type":"module"}');
  write(root, 'node_modules/turbo/bin/turbo', instrument('typecheck'));
  write(root, 'scripts/build-server.mjs', instrument('Nest build'));
  write(root, 'apps/api/dist/bootstrap-probe.mjs', instrument('Nest probe'));
  write(root, 'node_modules/vitest/vitest.mjs', instrument('tests'));
  ok(command(root, process.execPath, ['scripts/install-git-hooks.mjs']));
  write(root, 'notes.md', '# Initial\n');
  ok(git(root, 'add', '--', 'notes.md'));
  ok(git(root, 'commit', '-m', 'Initial fixture'));
  return root;
}

function blockedCommit(root, expected) {
  const before = ok(git(root, 'rev-parse', 'HEAD'));
  const result = git(root, 'commit', '-m', 'Must be rejected');
  expect(result.status).not.toBe(0);
  expect(result.stdout + result.stderr).toContain(expected);
  expect(ok(git(root, 'rev-parse', 'HEAD'))).toBe(before);
  return result.stdout + result.stderr;
}

afterEach(() => {
  for (const root of fixtures.splice(0)) {
    // Recursive cleanup is restricted to the exact temporary directories created by this test.
    if (dirname(resolve(root)) !== resolve(testRoot)) throw new Error('Unsafe fixture cleanup');
    rmSync(root, { recursive: true, force: true });
  }
});

describe('native hooks invoked by real Git', () => {
  it('blocks a recognizable credential without printing its content', () => {
    const root = fixture();
    const credential = ['ghp_', 'a'.repeat(40)].join('');
    write(root, 'credential-fixture.txt', credential);
    ok(git(root, 'add', '--', 'credential-fixture.txt'));
    expect(blockedCommit(root, 'Commit blocked')).not.toContain(credential);
  }, 30_000);

  it('blocks a forbidden staged path', () => {
    const root = fixture();
    write(root, '.env', 'EXAMPLE=value\n');
    ok(git(root, 'add', '--', '.env'));
    blockedCommit(root, 'Commit blocked');
  }, 30_000);

  it('blocks a real ESLint violation', () => {
    const root = fixture();
    write(root, 'bad.mjs', 'debugger;\n');
    ok(git(root, 'add', '--', 'bad.mjs'));
    blockedCommit(root, 'no-debugger');
  }, 30_000);

  it('blocks a real Prettier parsing failure', () => {
    const root = fixture();
    write(root, 'broken.json', '{ "unfinished": }');
    ok(git(root, 'add', '--', 'broken.json'));
    blockedCommit(root, 'staged format failed');
  }, 30_000);

  it('does not stage or overwrite uncommitted parts of a partially staged file', () => {
    const root = fixture();
    write(root, 'notes.md', '# Intended\n');
    ok(git(root, 'add', '--', 'notes.md'));
    const working = '# Intended\n\nUnstaged work\n';
    write(root, 'notes.md', working);
    blockedCommit(root, 'Partially staged files');
    expect(ok(git(root, 'show', ':notes.md'))).toBe('# Intended');
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe(working);
  }, 30_000);

  it('formats and stages only selected files, including filenames containing shell syntax', () => {
    const root = fixture();
    const filename = 'odd $(command) [x].mjs';
    write(root, filename, 'export const value=1');
    write(root, 'notes.md', '# Unstaged\n');
    ok(git(root, 'add', '--', filename));
    ok(git(root, 'commit', '-m', 'Formatted fixture'));
    expect(ok(git(root, 'show', `HEAD:${filename}`))).toBe('export const value = 1;');
    expect(ok(git(root, 'show', 'HEAD:notes.md'))).toBe('# Initial');
    expect(readFileSync(join(root, 'notes.md'), 'utf8')).toBe('# Unstaged\n');
  }, 30_000);

  it.each(['typecheck', 'Nest build', 'Nest probe', 'tests'])(
    'blocks a real push when %s fails',
    (stage) => {
      const root = fixture();
      const remote = join(root, 'remote.git');
      ok(git(root, 'init', '--bare', remote));
      ok(git(root, 'push', remote, 'main'));
      const remoteBefore = ok(git(root, '--git-dir', remote, 'rev-parse', 'main'));
      write(root, 'notes.md', '# Next\n');
      ok(git(root, 'add', '--', 'notes.md'));
      ok(git(root, 'commit', '-m', 'Pending update'));
      write(root, '.test-calls', '');
      write(root, '.test-failure', stage);
      const result = git(root, 'push', remote, 'main');
      expect(result.status).not.toBe(0);
      expect(result.stdout + result.stderr).toContain(`${stage} failed`);
      expect(ok(git(root, '--git-dir', remote, 'rev-parse', 'main'))).toBe(remoteBefore);
      const stages = ['typecheck', 'Nest build', 'Nest probe', 'tests'];
      const calls = readFileSync(join(root, '.test-calls'), 'utf8')
        .trim()
        .split('\n')
        .map((line) => JSON.parse(line));
      expect(calls.map((call) => call.stage)).toEqual(stages.slice(0, stages.indexOf(stage) + 1));
      rmSync(join(root, '.test-failure'));
      ok(git(root, 'push', remote, 'main'));
      expect(ok(git(root, '--git-dir', remote, 'rev-parse', 'main'))).toBe(
        ok(git(root, 'rev-parse', 'HEAD')),
      );
    },
    30_000,
  );

  it('fails closed when a required pre-push executable is missing', () => {
    const root = fixture();
    const remote = join(root, 'remote.git');
    ok(git(root, 'init', '--bare', remote));
    rmSync(join(root, 'node_modules/turbo/bin/turbo'));
    const result = git(root, 'push', remote, 'main');
    expect(result.status).not.toBe(0);
    expect(result.stdout + result.stderr).toContain('typecheck failed');
    expect(ok(git(root, 'ls-remote', remote, 'refs/heads/main'))).toBe('');
  }, 30_000);

  it('replaces generated Lefthook hooks, remains idempotent, and preserves unrelated/custom hooks', () => {
    const root = fixture();
    write(root, '.git/hooks/pre-commit', '#!/bin/sh\ncall_lefthook run "pre-commit" "$@"\n');
    write(root, '.git/hooks/post-commit', '#!/bin/sh\n# User hook\n');
    ok(command(root, process.execPath, ['scripts/install-git-hooks.mjs']));
    ok(command(root, process.execPath, ['scripts/install-git-hooks.mjs']));
    expect(readFileSync(join(root, '.git/hooks/post-commit'), 'utf8')).toContain('# User hook');
    const before = readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8');
    write(root, '.git/hooks/pre-push', '#!/bin/sh\n# Custom validation\n');
    expect(command(root, process.execPath, ['scripts/install-git-hooks.mjs']).status).not.toBe(0);
    expect(readFileSync(join(root, '.git/hooks/pre-commit'), 'utf8')).toBe(before);
    expect(readFileSync(join(root, '.git/hooks/pre-push'), 'utf8')).toContain(
      '# Custom validation',
    );
    ok(git(root, 'config', 'core.hooksPath', 'custom-hooks'));
    expect(command(root, process.execPath, ['scripts/install-git-hooks.mjs']).status).not.toBe(0);
    expect(ok(git(root, 'config', '--get', 'core.hooksPath'))).toBe('custom-hooks');
    expect(existsSync(join(root, 'custom-hooks'))).toBe(false);
  }, 30_000);
});
