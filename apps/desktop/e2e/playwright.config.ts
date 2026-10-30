import { defineConfig } from '@playwright/test';

/**
 * End-to-end tests drive the built desktop app through Electron. Each test gets its own user
 * data folder, so they never touch a real install or a running dev instance.
 */
export default defineConfig({
  testDir: '.',
  testMatch: '**/*.e2e.ts',
  globalSetup: './globalSetup.ts',
  // One Electron at a time by default: every instance starts its own terminal host and CLI
  // probes. Each launch has a profile, lock and terminal pipe of its own, so a machine with room
  // for more sets RUNOVA_E2E_WORKERS. Spec files then share out across workers, and the tests in a
  // file still run in order on one worker.
  workers: Number(process.env.RUNOVA_E2E_WORKERS) || 1,
  fullyParallel: false,
  timeout: 120_000,
  expect: { timeout: 20_000 },
  // The CI retry only tells a flaky failure from a steady one. A test that needed it still fails
  // the run, so a race can't hide behind a green check.
  retries: process.env.CI ? 1 : 0,
  failOnFlakyTests: !!process.env.CI,
  reporter: process.env.CI ? [['list'], ['html', { open: 'never' }]] : 'list',
  outputDir: '../test-results/e2e',
  use: {
    trace: 'retain-on-failure',
    screenshot: 'only-on-failure',
  },
});
