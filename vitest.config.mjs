import { configDefaults, defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    // Git snapshots and benchmark artifacts are copies, not this checkout's test sources.
    exclude: [...configDefaults.exclude, '.local/**'],
  },
});
