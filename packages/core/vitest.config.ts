import { defineConfig } from 'vitest/config';

/** Pure TypeScript, so there is nothing to stub: plain Node, tests beside their source. */
export default defineConfig({
  test: {
    include: ['src/**/*.test.ts'],
    environment: 'node',
    reporters: process.env.CI
      ? ['default', 'github-actions', ['junit', { outputFile: 'test-results/junit.xml' }]]
      : ['default'],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts'],
      exclude: ['src/**/*.test.ts', 'src/**/types.ts', 'src/types/**', 'src/index.ts'],
      reporter: ['text-summary', 'json-summary', 'lcov', 'html'],
      thresholds: {
        // The parsers that turn scanner output into findings, and the skill audit, are the parts
        // where a silent mistake matters most.
        'src/security/**': { lines: 80, branches: 70 },
        'src/skills/securityAudit.ts': { lines: 85, branches: 75 },
        'src/git/**': { lines: 80, branches: 70 },
        // What the Deploy section renders into config on a server, and what it leaves out of an
        // upload.
        'src/deploy/validation.ts': { lines: 90, branches: 85 },
        'src/deploy/env/**': { lines: 90, branches: 85 },
        'src/deploy/dockerignore.ts': { lines: 90, branches: 85 },
        'src/deploy/compose/**': { lines: 90, branches: 80 },
        'src/deploy/catalog/**': { lines: 90, branches: 85 },
        // The prompt a container's log turns into, which must never carry an environment value.
        'src/deploy/prompts.ts': { lines: 95, branches: 90 },
        // The WordPress connector protocol (E19): what is signed, what is refused, what syncs.
        'src/deploy/wordpress/**': { lines: 95, branches: 90 },
        // Project health checks (E22): what a report is read as, and what it is scrubbed of.
        'src/health/**': { lines: 95, branches: 85 },
        // Error tracking (E24): what a provider's JSON is read as, and what it is scrubbed of.
        'src/errorTracking/**': { lines: 95, branches: 85 },
      },
    },
  },
});
