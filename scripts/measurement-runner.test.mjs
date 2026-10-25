import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { fileURLToPath } from 'node:url';

const mocks = vi.hoisted(() => ({
  query: vi.fn(),
  spawn: vi.fn(),
  build: vi.fn(),
  stop: vi.fn(),
}));
vi.mock('node:os', () => ({ platform: () => 'win32' }));
vi.mock('node:child_process', () => ({ execFileSync: mocks.query, spawn: mocks.spawn }));
vi.mock('node:fs/promises', () => ({
  readdir: async () => ['warm.e2e.ts', 'cold.e2e.ts', 'capacity.e2e.ts'],
}));
vi.mock('esbuild', () => ({ build: mocks.build, stop: mocks.stop }));

const originalArgv = process.argv;
beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  mocks.query.mockReset();
  mocks.build.mockResolvedValue(undefined);
  vi.spyOn(console, 'log').mockImplementation(() => {});
  vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(process, 'exit').mockImplementation((code) => {
    throw new Error(`EXIT_CODE=${code}`);
  });
});
afterEach(() => {
  process.argv = originalArgv;
  vi.restoreAllMocks();
});

it.each(['warm', 'cold', 'capacity'])(
  'refuses direct %s before compilation or benchmark when on battery',
  async (suite) => {
    process.argv = [
      process.execPath,
      fileURLToPath(new URL('./test-collab.mjs', import.meta.url)),
      '--suite',
      suite,
    ];
    mocks.query.mockReturnValue('{"BatteryStatus":1}');
    await expect(import('./test-collab.mjs')).rejects.toThrow('EXIT_CODE=3');
    expect(mocks.build).not.toHaveBeenCalled();
    expect(mocks.spawn).not.toHaveBeenCalled();
    expect(console.error).toHaveBeenCalledWith(expect.stringContaining('Branche le portable'));
  },
);

it('checks again after compilation and refuses a disconnect before starting the series', async () => {
  process.argv = [
    process.execPath,
    fileURLToPath(new URL('./test-collab.mjs', import.meta.url)),
    '--suite',
    'warm',
  ];
  mocks.query.mockReturnValueOnce('{"BatteryStatus":2}').mockReturnValueOnce('{"BatteryStatus":1}');
  await expect(import('./test-collab.mjs')).rejects.toThrow('EXIT_CODE=3');
  expect(mocks.build).toHaveBeenCalledTimes(2);
  expect(mocks.stop).toHaveBeenCalled();
  expect(mocks.query).toHaveBeenCalledTimes(2);
  expect(mocks.spawn).not.toHaveBeenCalled();
});
