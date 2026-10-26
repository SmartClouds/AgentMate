import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * The app starts, the preload bridge is there, and everything it writes stays inside the test's
 * own profile. That last part is what lets the suite run on a machine where the real Runova is
 * open: a shared profile would fight over the single-instance lock and the terminal host pipe.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('the window opens with the bridge and the app version in place', async () => {
  launched = await launchApp({ settings: {} });
  const { app, page } = launched;

  await expect(page.locator('body')).toBeVisible();

  // An unpackaged run has no app version of its own: Windows reports Electron's, Linux reports
  // "0.0". So this only checks that something is there, and the real version comes from
  // package.json below.
  const version = await app.evaluate(({ app: electronApp }) => electronApp.getVersion());
  expect(version).toMatch(/^\d+\.\d+/);
  const manifest = JSON.parse(readFileSync(join(__dirname, '..', 'package.json'), 'utf-8')) as {
    version: string;
  };
  expect(manifest.version).toMatch(/^\d+\.\d+\.\d+/);

  // The renderer cannot work at all without the preload bridge.
  const namespaces = await page.evaluate(() =>
    Object.keys((window as unknown as { runova: Record<string, unknown> }).runova),
  );
  expect(namespaces).toContain('settings');
  expect(namespaces).toContain('projects');
  expect(namespaces).toContain('terminal');
});

test('writes only inside the profile it was given', async () => {
  launched = await launchApp({ settings: { theme: 'dark' } });
  const { app, userDataDir } = launched;

  const reported = await app.evaluate(({ app: electronApp }) => electronApp.getPath('userData'));
  expect(reported.toLowerCase()).toBe(userDataDir.toLowerCase());

  // Settings are read and written under that folder, not the installed app's profile.
  await expect.poll(() => existsSync(join(userDataDir, 'data', 'settings.json'))).toBe(true);
  expect(launched.settingsOnDisk().theme).toBe('dark');
});

test('the renderer reports no page errors while it boots', async () => {
  const errors: string[] = [];
  launched = await launchApp({ settings: {} });
  launched.page.on('pageerror', (error) => errors.push(error.message));
  launched.page.on('console', (message) => {
    if (message.type() === 'error') errors.push(message.text());
  });

  // Give the first render and its queries a moment to settle.
  await launched.page.waitForTimeout(3_000);
  expect(errors).toEqual([]);
});
