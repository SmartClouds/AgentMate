import { type ChildProcess, spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { E2E_OUT_DIR } from './paths';

/**
 * The whole suite leans on one thing: a Runova started with its own profile never touches
 * another one. Two guarantees back that up, and both are checked here.
 *
 * A second app on the SAME profile must lose the single-instance lock and quit, leaving the first
 * one running (that is what keeps a test from stealing the window of a real install, or of the
 * app the developer has open). Two apps on DIFFERENT profiles must both run, which is what lets
 * a test launch a second instance at all (backup.e2e.ts does).
 *
 * The same-profile case cannot use `launchApp`: Playwright's Electron launcher waits for a window
 * that this process is never going to open, so it is started directly instead, the same way
 * `app.ts` does.
 */

// The electron package's main export is the path to its binary. Playwright loads these files as
// CommonJS (see paths.ts), so the resolver is built from __filename rather than import.meta.
const electronPath = createRequire(__filename)('electron') as unknown as string;

let launched: LaunchedApp | undefined;
let other: LaunchedApp | undefined;
let second: ChildProcess | undefined;

test.afterEach(async () => {
  if (second && second.exitCode === null) second.kill();
  second = undefined;
  await other?.close();
  other = undefined;
  await launched?.close();
  launched = undefined;
});

/** Starts the built app on `userDataDir` without waiting for a window. */
function startOnProfile(userDataDir: string): ChildProcess {
  return spawn(
    electronPath,
    [
      join(E2E_OUT_DIR, 'main', 'index.mjs'),
      `--user-data-dir=${userDataDir}`,
      ...(process.env.RUNOVA_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
    {
      env: {
        ...(process.env as Record<string, string>),
        ELECTRON_RENDERER_URL: '',
        RUNOVA_USER_DATA_DIR: userDataDir,
        RUNOVA_E2E: '1',
      },
      stdio: 'ignore',
    },
  );
}

function exitCodeOf(child: ChildProcess): number | null {
  return child.exitCode;
}

test('a second app on the same profile quits and leaves the first running', async () => {
  launched = await launchApp({ settings: {} });
  const { page, app, userDataDir } = launched;
  await expect(page.getByRole('link', { name: 'Projects' })).toBeVisible();

  second = startOnProfile(userDataDir);
  // The lock is retried for a couple of seconds before the loser gives up (see
  // acquireSingleInstanceLock), so this needs room.
  await expect.poll(() => exitCodeOf(second!), { timeout: 60_000 }).not.toBe(null);
  expect(exitCodeOf(second!)).toBe(0);

  // The one that owns the profile is untouched and still answering.
  expect(app.process().exitCode).toBe(null);
  await page.getByRole('link', { name: 'Settings' }).click();
  await expect(page.getByRole('group', { name: 'Theme' })).toBeVisible();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/settings');
});

test('two apps on different profiles both run', async () => {
  launched = await launchApp({ settings: { theme: 'dark' } });
  other = await launchApp({ settings: { theme: 'light' } });

  expect(other.userDataDir).not.toBe(launched.userDataDir);
  for (const instance of [launched, other]) {
    expect(instance.app.process().exitCode).toBe(null);
    await expect(instance.page.getByRole('link', { name: 'Projects' })).toBeVisible();
  }

  // Each one reads and writes only its own profile, so the two settings never mix.
  expect(launched.settingsOnDisk().theme).toBe('dark');
  expect(other.settingsOnDisk().theme).toBe('light');
  await other.page.evaluate(() =>
    (
      window as unknown as { runova: { settings: { update(patch: unknown): Promise<unknown> } } }
    ).runova.settings.update({ theme: 'vs2026' }),
  );
  await expect.poll(() => other?.settingsOnDisk().theme).toBe('vs2026');
  expect(launched.settingsOnDisk().theme).toBe('dark');
});
