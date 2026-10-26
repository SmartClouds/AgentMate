import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp, OS_COLOR_SCHEME, openWorkspace } from './app';
import { E2E_OUT_DIR } from './paths';

/**
 * The main window opens on the page it was on when the app closed, or on the page picked under
 * Settings > General > Startup page. The app is stopped with app.quit(), the same path as closing
 * the window, restarting for an update or logging off, so `before-quit` and `close` both run.
 */

let launched: LaunchedApp | undefined;
let relaunched: ElectronApplication | undefined;

test.afterEach(async () => {
  if (relaunched) await closeApp(relaunched, launched?.root);
  relaunched = undefined;
  await launched?.close();
  launched = undefined;
});

function savedRoute(userDataDir: string): string | null {
  const file = join(userDataDir, 'data', 'last-route.json');
  if (!existsSync(file)) return null;
  return (JSON.parse(readFileSync(file, 'utf-8')) as { route?: string }).route ?? null;
}

/**
 * The hash the main window loaded, or null while it is still loading. The main window is the
 * only one with the app's minimum size; the splash can't be resized.
 */
function mainWindowHash(app: ElectronApplication): Promise<string | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (one) => !one.isDestroyed() && one.getMinimumSize()[0] === 960,
    );
    // Before the first load starts the URL is still empty and isLoading() is false.
    const url = win?.webContents.getURL();
    if (!win || !url || win.webContents.isLoading()) return null;
    return new URL(url).hash;
  });
}

/** Quits the way closing the window does, then starts a new app on the same profile. */
async function restart(current: LaunchedApp): Promise<ElectronApplication> {
  const exited = new Promise<void>((resolve) =>
    current.app.process().once('exit', () => resolve()),
  );
  await current.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);

  relaunched = await electron.launch({
    ...OS_COLOR_SCHEME,
    args: [
      join(E2E_OUT_DIR, 'main', 'index.mjs'),
      `--user-data-dir=${current.userDataDir}`,
      ...(process.env.RUNOVA_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      RUNOVA_USER_DATA_DIR: current.userDataDir,
      RUNOVA_E2E: '1',
    },
  });
  return relaunched;
}

async function goTo(current: LaunchedApp, hash: string): Promise<void> {
  await current.page.evaluate((next) => {
    location.hash = next;
  }, hash);
}

test('opens on the page the app was on when it closed', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;

  await goTo(current, '#/settings?tab=network');
  await expect.poll(() => savedRoute(current.userDataDir)).toBe('/settings?tab=network');

  const next = await restart(current);

  await expect.poll(() => mainWindowHash(next)).toBe('#/settings?tab=network');
});

test('opens on the same workspace project', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;

  const projectId = await openWorkspace(current);
  await expect.poll(() => savedRoute(current.userDataDir)).toBe(`/workspace/${projectId}`);

  const next = await restart(current);

  await expect.poll(() => mainWindowHash(next)).toBe(`#/workspace/${projectId}`);
});

test('opens on the startup page the user picked instead', async () => {
  launched = await launchApp({ settings: { startupPage: '/' } });
  const current = launched;

  await goTo(current, '#/usage');
  await expect.poll(() => savedRoute(current.userDataDir)).toBe('/usage');

  const next = await restart(current);

  await expect.poll(() => mainWindowHash(next)).toMatch(/^(#\/?)?$/);
});
