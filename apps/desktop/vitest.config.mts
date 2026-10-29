import { fileURLToPath } from 'node:url';
import react from '@vitejs/plugin-react';
import { defineConfig } from 'vitest/config';

const path = (relative: string): string => fileURLToPath(new URL(relative, import.meta.url));

// CI splits this suite across jobs with --shard and merges their blob reports afterwards. One
// shard covers only part of the code, so the thresholds are left to the merge run.
const sharded = process.argv.some((arg) => arg.startsWith('--shard'));

/**
 * Two suites in one run.
 *
 * "main" is the Electron main process plus the code it shares with the renderer. It runs in Node,
 * with `electron` and `better-sqlite3` swapped for the stand-ins in src/test/main: the real ones
 * need an Electron process, and better-sqlite3 gets rebuilt for Electron's ABI by `pnpm dev`,
 * after which plain Node can no longer load it.
 *
 * "renderer" is React, in jsdom, with the browser APIs and the heavy editors stubbed.
 */
export default defineConfig({
  plugins: [react()],
  resolve: {
    alias: {
      '@': path('./src/renderer/src'),
      '@shared': path('./src/shared'),
    },
  },
  test: {
    reporters: process.env.CI
      ? ['default', 'github-actions', ['junit', { outputFile: 'test-results/unit-junit.xml' }]]
      : ['default'],
    projects: [
      {
        extends: true,
        resolve: {
          alias: {
            electron: path('./src/test/main/electronMock.ts'),
            'better-sqlite3': path('./src/test/main/sqliteShim.ts'),
          },
        },
        test: {
          name: 'main',
          environment: 'node',
          include: [
            // Top-level checks that read the whole source tree, like cliSettingsContract.test.ts.
            'src/*.test.ts',
            'src/main/**/*.test.ts',
            'src/shared/**/*.test.ts',
            'src/preload/**/*.test.ts',
          ],
          setupFiles: ['src/test/main/setup.ts'],
          // Some of these start real servers, spawn git or open a pty.
          testTimeout: 20_000,
          hookTimeout: 20_000,
        },
      },
      {
        extends: true,
        resolve: {
          alias: {
            'monaco-editor': path('./src/test/renderer/mocks/monaco.ts'),
            '@devolutions/iron-remote-desktop': path('./src/test/renderer/mocks/ironRdp.ts'),
            '@devolutions/iron-remote-desktop-rdp': path('./src/test/renderer/mocks/ironRdp.ts'),
            'framer-motion': path('./src/test/renderer/mocks/framerMotion.tsx'),
          },
        },
        test: {
          name: 'renderer',
          environment: 'jsdom',
          include: ['src/renderer/**/*.test.{ts,tsx}'],
          setupFiles: ['src/test/renderer/setup.ts'],
          testTimeout: 15_000,
          // The first beforeEach in a file imports every store module (see resetAllStoresAsync),
          // which under a full parallel run can pass the 10s default.
          hookTimeout: 20_000,
        },
      },
    ],
    coverage: {
      provider: 'v8',
      include: ['src/**/*.ts', 'src/**/*.tsx'],
      exclude: [
        '**/*.test.{ts,tsx}',
        '**/*.d.ts',
        '**/testing/**',
        'src/test/**',
        // shadcn primitives, generated icon sets and pure type modules.
        'src/renderer/src/components/ui/**',
        'src/renderer/src/components/icons.tsx',
        'src/shared/apiTypes.ts',
        // Entry points, window wiring and workers: the end-to-end suite covers these instead.
        'src/main/index.ts',
        'src/main/vault/index.ts',
        'src/main/deploy/index.ts',
        'src/main/deploy/cloudflare/index.ts',
        'src/main/deploy/registry/index.ts',
        'src/main/deploy/wordpress/index.ts',
        'src/main/deploy/files/index.ts',
        'src/main/sftp/index.ts',
        // Deploy hands itself to the file manager at start-up (E27), between the two entry points above.
        'src/main/deploy/dockerFiles/backend.ts',
        // FTP and SFTP sites (E23): the contract suite and the in-memory server only serve the tests.
        'src/main/deploy/files/transport/contract.ts',
        'src/main/deploy/files/transport/fakeRemote.ts',
        'src/renderer/src/main.tsx',
        'src/main/usage/usageScanWorker.ts',
        'src/main/agents/projectUsageWorker.ts',
        'src/main/agents/projectUsageWorkerClient.ts',
        'src/main/security/codeqlExtractWorker.ts',
        'src/main/ptyHost/hostEntry.ts',
        // Interface declarations with no runtime code of their own.
        'src/main/vault/ports.ts',
        'src/main/sftp/client.ts',
        // Generated from the server core's C# contracts (pnpm server-core:contracts).
        'src/shared/deploy/protocol/generated/**',
      ],
      reporter: ['text-summary', 'text', 'lcov', 'json-summary'],
      // A floor that holds the line at what is covered today, not a target. Raise it as the
      // renderer components get their tests, rather than leaving it where it is.
      thresholds: sharded
        ? undefined
        : {
            lines: 44,
            statements: 43,
            functions: 42,
            branches: 36,
            'src/main/**': { lines: 49, statements: 48, functions: 48, branches: 42 },
            'src/renderer/**': { lines: 37, statements: 36, functions: 34, branches: 32 },
            'src/shared/**': { lines: 95, statements: 95, functions: 95, branches: 90 },
            'src/preload/**': { lines: 90, statements: 90, functions: 90, branches: 65 },
            // The Vault was built test-first and holds its own bar.
            'src/main/vault/**': { lines: 90, statements: 90, functions: 90, branches: 80 },
            'src/main/ipc/vault.ts': { lines: 90, statements: 90, functions: 90, branches: 80 },
            // The write side of this one runs during a real backup, which the e2e suite covers.
            'src/main/backup/vaultSection.ts': {
              lines: 90,
              statements: 90,
              functions: 70,
              branches: 45,
            },
            'src/renderer/src/components/vault/**': { lines: 80, functions: 75, branches: 70 },
            'src/renderer/src/lib/vault/**': { lines: 80, functions: 75, branches: 70 },
            'src/renderer/src/stores/vaultStore.ts': { lines: 80, functions: 75, branches: 45 },
            'src/renderer/src/pages/VaultPage.tsx': { lines: 80, functions: 75, branches: 70 },
            // The security-sensitive modules, where a silent mistake matters most.
            'src/main/crypto/**': { lines: 90, branches: 85 },
            'src/main/backup/envelope.ts': { lines: 85, branches: 75 },
            'src/main/pathGuard.ts': { lines: 95, branches: 90 },
            'src/main/ptyHost/protocol.ts': { lines: 90, branches: 80 },
            'src/main/remote/tokens.ts': { lines: 90, branches: 80 },
            'src/main/usage/logParsers.ts': { lines: 80, branches: 70 },
            'src/main/rdp/rdcleanpath.ts': { lines: 85, branches: 75 },
            // How the app logs in to servers, runs root commands and tunnels to the server core.
            'src/main/ssh/connectConfig.ts': { lines: 95, branches: 85 },
            'src/main/ssh/connection.ts': { lines: 90, branches: 75 },
            'src/main/ssh/sudo.ts': { lines: 95, branches: 90 },
            'src/main/ssh/pool.ts': { lines: 90, branches: 75 },
            'src/main/ssh/savedServers.ts': { lines: 90, branches: 75 },
            // What runs as root on a user's server, and how the app reaches the core it installed.
            'src/main/deploy/bootstrap/**': { lines: 95, branches: 80 },
            'src/main/deploy/connection/**': { lines: 90, branches: 80 },
            // What leaves this computer for a server when a stack is built there.
            'src/main/deploy/stacks/**': { lines: 90, branches: 80 },
            // This computer's key on a core and the sessions it signs for.
            'src/main/deploy/auth/**': { lines: 95, branches: 85 },
            'src/main/deploy/service.ts': { lines: 95, branches: 80 },
            'src/main/deploy/state.ts': { lines: 90, branches: 85 },
            'src/main/ipc/deploy.ts': { lines: 95, branches: 90 },
            // Who can reach a core and what it recorded: users, devices, sessions, codes, the audit.
            'src/main/deploy/security.ts': { lines: 95, branches: 85 },
            'src/main/deploy/auditExport.ts': { lines: 95, branches: 90 },
            'src/main/ipc/deploySecurity.ts': { lines: 95, branches: 90 },
            // The Security center (E15): SSH fixes that cannot lock the app out, backups, restores.
            'src/main/deploy/hardening.ts': { lines: 95, branches: 85 },
            'src/main/deploy/backups.ts': { lines: 95, branches: 85 },
            'src/main/ipc/deployHardening.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/security/**': {
              lines: 90,
              functions: 85,
              branches: 80,
            },
            // Each server's lasting connection, its live streams, the Overview's calls and alerts.
            'src/main/deploy/live/**': { lines: 90, branches: 80 },
            'src/main/deploy/system.ts': { lines: 95, branches: 80 },
            'src/main/deploy/watcher.ts': { lines: 95, branches: 80 },
            'src/main/ipc/deploySystem.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/**': { lines: 85, functions: 75, branches: 75 },
            // A server's Overview: the pulse, the charts, updates, reboot and the live feeds.
            'src/renderer/src/components/deploy/overview/**': {
              lines: 90,
              functions: 85,
              branches: 80,
            },
            // A server's websites and certificates: nginx, sites, applying, site logs, Let's Encrypt.
            'src/main/deploy/sites/**': { lines: 95, branches: 85 },
            'src/main/ipc/deploySites.ts': { lines: 95, branches: 90 },
            'src/main/ipc/deploySitesInput.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/sites/**': {
              lines: 90,
              functions: 80,
              branches: 80,
            },
            'src/renderer/src/lib/deploy/sites/**': { lines: 95, branches: 90 },
            'src/renderer/src/pages/DeployPage.tsx': { lines: 85, functions: 75, branches: 75 },
            // The firewall (E13): safe apply, the rule checks and its screen.
            'src/main/deploy/firewall.ts': { lines: 95, branches: 85 },
            'src/main/ipc/deployFirewall.ts': { lines: 95, branches: 90 },
            'src/shared/deploy/firewallValidation.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/firewall/**': {
              lines: 90,
              functions: 85,
              branches: 80,
            },
            // The App Store (E12): installs rendered again in main, updates, the install sheet and card.
            'src/main/deploy/appStore/**': { lines: 95, branches: 85 },
            'src/main/ipc/deployAppStore.ts': { lines: 95, branches: 90 },
            // WordPress sites (E19): the signed client, pairing, the sync engine and their IPC.
            'src/main/deploy/wordpress/**': { lines: 90, branches: 80 },
            'src/main/ipc/deployWordPress.ts': { lines: 90, branches: 80 },
            // Project healthchecks (E22): the probe that holds a key, its scheduler and the IPC.
            'src/main/health/**': { lines: 90, branches: 80 },
            'src/main/ipc/health.ts': { lines: 90, branches: 80 },
            // Error tracking (E24): the Sentry client that holds a token, its store and the IPC.
            'src/main/errorTracking/**': { lines: 90, branches: 80 },
            'src/main/ipc/errorTracking.ts': { lines: 90, branches: 80 },
            // FTP and SFTP sites (E23): the planner, the run, trust, Deploy on save and the IPC.
            'src/main/deploy/files/**': { lines: 90, branches: 80 },
            'src/main/ipc/deployFiles.ts': { lines: 90, branches: 80 },
            // The SSH file manager (E25): transfers, remote and local file ops, the IPC and its screens.
            'src/main/sftp/**': { lines: 90, branches: 80 },
            'src/main/ipc/sftp.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/sftp/**': { lines: 85, functions: 75, branches: 75 },
            'src/renderer/src/lib/sftp/**': { lines: 95, branches: 90 },
            'src/renderer/src/stores/sftpStore.ts': { lines: 90, branches: 80 },
            'src/renderer/src/pages/SshFilesPage.tsx': { lines: 85, functions: 75, branches: 75 },
            // Files in containers and volumes (E27): the core's file client, its pool and the Files section.
            'src/main/deploy/dockerFiles/**': { lines: 90, branches: 80 },
            'src/renderer/src/components/deploy/serverFiles/**': {
              lines: 90,
              functions: 85,
              branches: 85,
            },
            'src/renderer/src/components/deploy/appStore/**': {
              lines: 90,
              functions: 80,
              branches: 80,
            },
            'src/renderer/src/stores/deploySetupStore.ts': { lines: 95, branches: 85 },
            'src/renderer/src/lib/deploy/**': { lines: 95, branches: 90 },
            // Docker on a server (E06): its calls, live streams and consoles, and the Containers screen.
            'src/main/deploy/docker.ts': { lines: 95, branches: 85 },
            'src/main/deploy/coreCalls.ts': { lines: 95, branches: 90 },
            'src/main/ipc/deployDocker.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/containers/**': {
              lines: 90,
              functions: 85,
              branches: 80,
            },
            'src/renderer/src/lib/terminal/containerConsoleAdapter.ts': { lines: 95, branches: 85 },
            // The Deploy AI and the logs center (E09): what it runs, the approvals it signs, its screens.
            'src/main/deploy/assistant/**': { lines: 95, branches: 85 },
            'src/main/deploy/logs/**': { lines: 95, branches: 85 },
            'src/main/ipc/deployAssistant.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/assistant/**': {
              lines: 90,
              functions: 80,
              branches: 80,
            },
            'src/renderer/src/components/deploy/logs/**': {
              lines: 90,
              functions: 80,
              branches: 80,
            },
            'src/renderer/src/stores/deployAssistantStore.ts': { lines: 95, branches: 85 },
            // The Cloudflare token lives here, and every call made with it.
            'src/main/deploy/cloudflare/**': { lines: 95, branches: 85 },
            'src/main/ipc/cloudflare.ts': { lines: 95, branches: 90 },
            'src/main/ipc/cloudflareServer.ts': { lines: 95, branches: 90 },
            'src/shared/cloudflare/dns01.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/cloudflare/**': { lines: 85, functions: 75, branches: 75 },
            // CI auto-fix commits and pushes to the user's branch on its own. The wiring module
            // only plugs the real ports in, everything that decides is held to these.
            'src/main/pipelines/autoFix/{machine,service,git,runs,launch}.ts': {
              lines: 90,
              branches: 80,
            },
            'src/main/ipc/ciAutoFix.ts': { lines: 95, branches: 85 },
            'src/renderer/src/components/pipelines/autoFix/**': {
              lines: 90,
              functions: 85,
              branches: 80,
            },
            'src/renderer/src/lib/cloudflare/**': { lines: 95, branches: 90 },
            // Registry sign-ins (E08): sealed here, sent with each deploy, never shown again.
            'src/main/deploy/registry/**': { lines: 95, branches: 85 },
            'src/main/ipc/deployRegistry.ts': { lines: 95, branches: 85 },
            'src/shared/deploy/registries.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/registries/**': {
              lines: 85,
              functions: 80,
              branches: 70,
            },
            // Direct TLS (E16): client certificates, the pin check, the fallback and its screen.
            'src/main/deploy/directTls/**': { lines: 95, branches: 85 },
            'src/main/ipc/deployDirectTls.ts': { lines: 95, branches: 90 },
            'src/shared/deploy/directTlsValidation.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/security/directTls/**': {
              lines: 90,
              functions: 80,
              branches: 75,
            },
            // Error reporting (E29): the DSN checks, the service, its IPC and its tab.
            'src/main/deploy/errorReporting/**': { lines: 95, branches: 90 },
            'src/main/ipc/deployErrorReporting.ts': { lines: 95, branches: 90 },
            'src/shared/deploy/errorReportingValidation.ts': { lines: 95, branches: 90 },
            'src/renderer/src/components/deploy/errorReporting/**': {
              lines: 90,
              functions: 80,
              branches: 75,
            },
            // Studio (E31): the desktop side of the service, its IPC, and the library and editor.
            'src/main/studio/**': { lines: 90, branches: 80 },
            'src/main/ipc/studio.ts': { lines: 95, branches: 75 },
            'src/renderer/src/components/studio/**': {
              lines: 90,
              functions: 85,
              branches: 80,
            },
            // Studio (E32): the streaming CLI run behind the scenario writer.
            // Branches for the POSIX spawn path only run on the Linux and Mac CI legs.
            'src/main/cli/headlessStream.ts': { lines: 95, branches: 70 },
          },
    },
  },
});
