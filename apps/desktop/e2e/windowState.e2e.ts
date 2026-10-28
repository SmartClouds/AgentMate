import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { type ElectronApplication, _electron as electron, expect, test } from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp, OS_COLOR_SCHEME } from './app';
import { E2E_OUT_DIR } from './paths';

/**
 * The main window opens the way it was left: same size and position, and maximized if it was
 * maximized when the app closed.
 *
 * The app is stopped with app.quit() rather than app.exit(): exit skips the window's `close`
 * event, and that is where the state gets written, the same as when the user closes the window.
 */

let launched: LaunchedApp | undefined;
let relaunched: ElectronApplication | undefined;

test.afterEach(async () => {
  if (relaunched) await closeApp(relaunched, launched?.root);
  relaunched = undefined;
  await launched?.close();
  launched = undefined;
});

/** Shows the windows, which maximizing needs. A test run keeps them hidden otherwise. */
const SHOW_WINDOWS = { RUNOVA_E2E_SHOW: '1' };

interface MainWindowInfo {
  bounds: { x: number; y: number; width: number; height: number };
  isMaximized: boolean;
  isVisible: boolean;
}

/** The main window is the only one with the app's minimum size; the splash can't be resized. */
function mainWindow(app: ElectronApplication): Promise<MainWindowInfo | null> {
  return app.evaluate(({ BrowserWindow }) => {
    const win = BrowserWindow.getAllWindows().find(
      (one) => !one.isDestroyed() && one.getMinimumSize()[0] === 960,
    );
    if (!win) return null;
    return {
      bounds: win.getNormalBounds(),
      isMaximized: win.isMaximized(),
      isVisible: win.isVisible(),
    };
  });
}

function savedState(userDataDir: string): Record<string, unknown> {
  return JSON.parse(readFileSync(join(userDataDir, 'data', 'window-state.json'), 'utf-8'));
}

/** Quits the way closing the window does, then starts a new app on the same profile. */
async function restart(
  current: LaunchedApp,
  env: Record<string, string> = {},
): Promise<ElectronApplication> {
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
      ...env,
    },
  });
  // The same wait launchApp has. Asking the main process about its windows while it is still
  // starting up can lose the evaluate ("Resulting promise was garbage collected" on macOS).
  const page = await relaunched.firstWindow();
  await page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  return relaunched;
}

test('the window keeps its size and position across a restart', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  // A spot that fits the screen. Windows won't open a window wider than its display, and the CI
  // machine's display is only 1024 pixels wide.
  const area = await current.app.evaluate(({ screen }) => screen.getPrimaryDisplay().workArea);
  const width = Math.min(1100, area.width - 20);
  const height = Math.min(720, area.height - 20);
  const bounds = {
    x: area.x + Math.min(60, area.width - width),
    y: area.y + Math.min(50, area.height - height),
    width,
    height,
  };

  await expect.poll(() => mainWindow(current.app)).not.toBeNull();
  await current.app.evaluate(({ BrowserWindow }, next) => {
    BrowserWindow.getAllWindows()
      .find((one) => one.getMinimumSize()[0] === 960)
      ?.setBounds(next);
  }, bounds);

  const next = await restart(current);

  expect(savedState(current.userDataDir)).toEqual({ bounds, isMaximized: false });
  await expect.poll(async () => (await mainWindow(next))?.bounds).toEqual(bounds);
});

test('a window closed maximized opens maximized again', async () => {
  // Linux CI runs under xvfb with no window manager, and nothing there can maximize a window.
  test.skip(process.platform === 'linux', 'maximizing needs a window manager');

  launched = await launchApp({ settings: {}, env: SHOW_WINDOWS });
  const current = launched;

  await expect.poll(async () => (await mainWindow(current.app))?.isVisible).toBe(true);
  await current.app.evaluate(({ BrowserWindow }) => {
    BrowserWindow.getAllWindows()
      .find((one) => one.getMinimumSize()[0] === 960)
      ?.maximize();
  });
  await expect.poll(async () => (await mainWindow(current.app))?.isMaximized).toBe(true);

  const next = await restart(current, SHOW_WINDOWS);

  expect(savedState(current.userDataDir)).toMatchObject({ isMaximized: true });
  await expect
    .poll(async () => {
      const win = await mainWindow(next);
      return win ? { isVisible: win.isVisible, isMaximized: win.isMaximized } : null;
    })
    .toEqual({ isVisible: true, isMaximized: true });
});
