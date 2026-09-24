import { defineConfig } from 'vitest/config';

export default defineConfig({
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // These suites spawn real Git processes, PTYs, child services, and local
    // HTTP listeners. Running files in parallel creates port and filesystem
    // races that are unrelated to the code under test.
    fileParallelism: false
  }
});
