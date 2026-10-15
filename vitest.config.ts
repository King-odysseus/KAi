import { defineConfig } from 'vitest/config';

export default defineConfig({
  // Vite leaves plain .mjs files to the runner, which chokes on the shebang line of the shipped `kai` command
  // script. Running esbuild over them strips the shebang, so the test can import the real file. (Vite's own default
  // covers .ts/.mts/.jsx/.tsx; only .mjs is added here.)
  esbuild: { include: /\.(m?ts|[jt]sx|mjs)$/ },
  test: {
    include: ['test/**/*.test.ts'],
    environment: 'node',
    // These suites spawn real Git processes, PTYs, child services, and local
    // HTTP listeners. Running files in parallel creates port and filesystem
    // races that are unrelated to the code under test.
    fileParallelism: false,
    // The learning tutor tests kill their forked worker part-way through on Windows (the timeout case), which hid
    // nine of them. The same file passes in full when run in a worker thread.
    poolMatchGlobs: [['**/desktop-learning.test.ts', 'threads']],
  }
});
