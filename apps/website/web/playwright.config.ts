import { defineConfig, devices } from '@playwright/test';

const port = Number(process.env.E2E_PORT || 4329);

// The tests run against the production build served by `bun run start`, so they also prove that
// the Node adapter output runs under the bun runtime.
export default defineConfig({
  testDir: 'e2e',
  fullyParallel: true,
  forbidOnly: Boolean(process.env.CI),
  retries: process.env.CI ? 1 : 0,
  reporter: process.env.CI ? 'github' : 'list',
  use: {
    baseURL: `http://127.0.0.1:${port}`,
    trace: 'retain-on-failure',
  },
  projects: [{ name: 'chromium', use: { ...devices['Desktop Chrome'] } }],
  webServer: {
    command: 'bun run build && bun run start',
    url: `http://127.0.0.1:${port}/`,
    env: { HOST: '127.0.0.1', PORT: String(port) },
    reuseExistingServer: false,
    timeout: 240_000,
  },
});
