import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vite';

/**
 * Builds the scene runtime to one classic script, `dist/bundle/studio-runtime.js`, that the scene
 * server puts at the top of every scene page. TypeScript's own build has no single-file output, so
 * Vite's library mode does this one file.
 */
export default defineConfig({
  build: {
    lib: {
      entry: fileURLToPath(new URL('./src/runtime/entry.ts', import.meta.url)),
      name: 'StudioRuntime',
      formats: ['iife'],
      fileName: () => 'studio-runtime.js',
    },
    outDir: 'dist/bundle',
    emptyOutDir: true,
    minify: false,
    sourcemap: false,
    target: 'chrome130',
  },
});
