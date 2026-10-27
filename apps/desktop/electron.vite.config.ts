import { existsSync } from 'node:fs';
import { resolve } from 'node:path';
import react from '@vitejs/plugin-react';
import tailwindcss from '@tailwindcss/vite';
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
        input: {
          index: resolve(__dirname, 'src/main/index.ts'),
          // Its own bundle: the agents' configs launch it as a stdio MCP server, outside the Electron process.
          'kai-project': resolve(__dirname, 'src/main/kai-project-server.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  preload: {
    plugins: [externalizeDepsPlugin({ exclude: ['@kai/contracts'] })],
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/preload/index.ts'),
          preview: resolve(__dirname, 'src/preload/preview.ts'),
        },
        output: {
          format: 'cjs',
          entryFileNames: '[name].cjs',
        },
      },
    },
  },
  renderer: {
    root: resolve(__dirname, 'src/renderer'),
    // The phone's static shell — manifest, icons, service worker — lives here and nowhere else, because
    // Vite copies `public/` to the bundle root verbatim. Importing them instead would give them hashed
    // URLs, and both are fetched by a fixed path; the gateway publishes `/mobile/` and `/assets/` only,
    // so `public/mobile/…` is exactly the prefix the phone needs.
    publicDir: resolve(__dirname, 'src/renderer/public'),
    plugins: [react(), tailwindcss()],
    resolve: {
      alias: [
        { find: /^monaco-worker\/(.*)$/, replacement: `${monacoEsmRoot}/$1` },
        { find: /^monaco-editor\/(.*)$/, replacement: `${monacoEsmRoot}/$1` },
      ],
    },
    build: {
      rollupOptions: {
        input: {
          index: resolve(__dirname, 'src/renderer/index.html'),
          // The phone console. A separate bundle, not the workbench made narrow — see Ground Rule 1.
          mobile: resolve(__dirname, 'src/renderer/mobile/index.html'),
        },
      },
    },
  },
});
