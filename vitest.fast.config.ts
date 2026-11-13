import { defineConfig } from 'vitest/config';
import { fastTestFiles } from './vitest.tiers';

/** Unit and contract tests that do not start child processes, Git, PTYs or local servers. */
export default defineConfig({
  esbuild: { include: /\.(m?ts|[jt]sx|mjs)$/ },
  test: {
    include: fastTestFiles(),
    environment: 'node',
    fileParallelism: true,
    minWorkers: 1,
    maxWorkers: 4,
  },
});
