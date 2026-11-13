import { defineConfig } from 'vitest/config';
import { slowTestFiles } from './vitest.tiers';

/** The tests that start real Git processes, child processes or terminals, one file at a time. */
export default defineConfig({
  esbuild: { include: /\.(m?ts|[jt]sx|mjs)$/ },
  test: {
    include: slowTestFiles(),
    environment: 'node',
    fileParallelism: false,
    // Same exception as the main config: this file kills its forked worker on Windows.
    poolMatchGlobs: [['**/desktop-learning.test.ts', 'threads']],
  },
});
