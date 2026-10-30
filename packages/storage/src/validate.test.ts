import { it, expect } from 'vitest';
import { mkdtemp, mkdir, writeFile, access, rm } from 'node:fs/promises';
import { resolve } from 'node:path';
import { cleanupValidationDirectory, validatorConfig } from './validate.ts';
it('worker private snapshots cannot be mounted into the exchange, quota is bounded', () => {
  expect(() =>
    validatorConfig({
      FILES_VALIDATOR_DIRECTORY: '.local/ex',
      FILES_VALIDATOR_PRIVATE_DIRECTORY: '.local/ex/private',
    }),
  ).toThrow('OUTSIDE_EXCHANGE');
  expect(() => validatorConfig({ FILES_VALIDATOR_EXCHANGE_BYTES: '1' })).toThrow('BUDGET');
  expect(validatorConfig({}).budgetBytes).toBe(6 * 1024 ** 3);
});
it('reclaims only marked stale job files, preserves active and unknown folders', async () => {
  await mkdir('.local/validator-unit', { recursive: true });
  const root = await mkdtemp(resolve('.local/validator-unit/run-'));
  // Check the resolved task-owned child before permitting any recursive test cleanup.
  if (
    !root.startsWith(
      resolve('.local/validator-unit') +
        String.fromCharCode(process.platform === 'win32' ? 92 : 47),
    )
  )
    throw Error('Unexpected test path');
  try {
    for (const name of ['job-Abc123', 'job-Def456', 'unrelated']) {
      await mkdir(resolve(root, name, 'input'), { recursive: true });
      await mkdir(resolve(root, name, 'output'));
      await writeFile(resolve(root, name, 'owner'), 'memoria-file-validation-v1');
      await writeFile(resolve(root, name, 'input/source'), 'fixture');
    }
    await writeFile(resolve(root, 'job-Def456/output/unknown'), 'do not delete');
    expect(await cleanupValidationDirectory(root)).toBe(0);
    expect(await cleanupValidationDirectory(root, Date.now() + 7200000)).toBe(1);
    await expect(access(resolve(root, 'job-Abc123'))).rejects.toThrow();
    await access(resolve(root, 'job-Def456/output/unknown'));
    await access(resolve(root, 'unrelated/input/source'));
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
