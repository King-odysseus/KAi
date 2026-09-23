import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import { defineConfig, externalizeDepsPlugin } from 'electron-vite';

// Monaco's package exports do not expose its worker entry points to Vite's `?worker` loader,
// so they are reached through an alias to the package's ESM folder.
const monacoCandidates = [
  resolve(__dirname, 'node_modules/monaco-editor/esm/vs'),
  resolve(__dirname, '../../node_modules/monaco-editor/esm/vs'),
];
const monacoEsmRoot = monacoCandidates.find((candidate) => existsSync(candidate)) ?? monacoCandidates[1]!;

export default defineConfig({
  main: {
    plugins: [externalizeDepsPlugin({ exclude: ['@kai/contracts', '@kai/integrations', '@kai/runtime'] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/main/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@kai/contracts'] })],
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/preload/index.ts'),
        output: {
          format: 'cjs',
          entryFileNames: 'index.cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    plugins: [react()],
    resolve: {
      alias: [{ find: /^monaco-worker\/(.*)$/, replacement: `${monacoEsmRoot}/$1` }],
    },
    build: {
      rollupOptions: {
        input: resolve(__dirname, 'src/renderer/index.html'),
      },
    },
  },
});
