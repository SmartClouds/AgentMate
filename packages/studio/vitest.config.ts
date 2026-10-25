import { defineConfig } from 'vitest/config';

/**
 * Plain Node, tests beside their source. Studio keeps everything that can lose a user's work here
 * (the document, its edit log and the files on disk), so the floors are high.
 */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    testTimeout: 20_000,
    reporters: process.env.CI
      ? ['default', 'github-actions', ['junit', { outputFile: 'test-results/junit.xml' }]]
      : ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/test/**', 'src/index.ts', 'src/node/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      thresholds: {
        // E31: the document, its ops and undo, and the time base everything is measured in.
        'src/document/**': { lines: 95, branches: 90 },
        'src/time/**': { lines: 100, branches: 95 },
        // E31: what writes a user's video to disk and reads it back after a crash.
        'src/node/project/**': { lines: 92, branches: 85 },
        'src/node/db/**': { lines: 92, branches: 85 },
        'src/node/blobs/**': { lines: 92, branches: 85 },
        'src/node/fs/**': { lines: 92, branches: 85 },
        // E32: reading AI answers and turning them into edits, and the runs that ask for them.
        'src/ai/**': { lines: 95, branches: 85 },
        'src/node/ai/**': { lines: 92, branches: 78 },
        'src/node/recipes/**': { lines: 92, branches: 85 },
      },
    },
  },
});
