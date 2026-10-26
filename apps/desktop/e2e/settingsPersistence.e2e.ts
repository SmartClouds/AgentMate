import { join } from 'node:path';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp, OS_COLOR_SCHEME } from './app';
import { E2E_OUT_DIR } from './paths';

/**
 * Settings the user changes have to outlive the app. The theme goes through the settings file in
 * the profile, a rebound shortcut goes through the renderer's own storage, and both are read
 * back by a second app started on the same profile.
 *
 * The theme is the one place where asserting on a class is the point: `<html>` carrying `dark`
 * is how every themed rule in the app is switched on (see themeStore.themeClassName).
 */

let launched: LaunchedApp | undefined;
let relaunched: ElectronApplication | undefined;

/**
 * Bindings are written the way the platform writes them (see formatShortcut): Ctrl+Shift+J on
 * Windows and Linux, the glyphs on macOS. The keys pressed below stay the same either way, since
 * the app takes Ctrl and Command as the same modifier.
 */
const MAC = process.platform === 'darwin';
const CTRL_P = MAC ? '⌘P' : 'Ctrl+P';
const CTRL_K = MAC ? '⌘K' : 'Ctrl+K';
const CTRL_SHIFT_J = MAC ? '⌘⇧J' : 'Ctrl+Shift+J';

test.afterEach(async () => {
  if (relaunched) await closeApp(relaunched, launched?.root);
  relaunched = undefined;
  await launched?.close();
  launched = undefined;
});

/** Stops the running app and starts a new one on the same profile, the way a restart does. */
async function relaunch(current: LaunchedApp): Promise<Page> {
  const exited = new Promise<void>((resolve) =>
    current.app.process().once('exit', () => resolve()),
  );
  await current.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
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
  const page = await relaunched.firstWindow();
  await page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  return page;
}

function htmlClasses(page: Page): Promise<string[]> {
  return page.evaluate(() => Array.from(document.documentElement.classList));
}

async function openSettings(page: Page, tab: string): Promise<void> {
  await page.evaluate((next) => {
    window.location.hash = `#/settings?tab=${next}`;
  }, tab);
}

test('the theme and a rebound shortcut both survive a restart', async () => {
  launched = await launchApp({ settings: { theme: 'light' } });
  const current = launched;
  const { page } = current;

  await openSettings(page, 'general');
  const themes = page.getByRole('group', { name: 'Theme' });
  await expect(themes).toBeVisible();
  expect(await htmlClasses(page)).not.toContain('dark');

  await themes.getByRole('button', { name: /^Dark/ }).click();
  await expect(themes.getByRole('button', { name: /^Dark/ })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect.poll(() => htmlClasses(page)).toContain('dark');
  await expect.poll(() => current.settingsOnDisk().theme).toBe('dark');

  // A theme with its own variable set applies both classes, so the page really switched.
  await themes.getByRole('button', { name: /^VS Code Dark/ }).click();
  await expect.poll(() => htmlClasses(page)).toContain('theme-vscode-dark');
  await expect.poll(() => current.settingsOnDisk().theme).toBe('vscode-dark');
  await themes.getByRole('button', { name: /^Dark/ }).click();
  await expect.poll(() => current.settingsOnDisk().theme).toBe('dark');

  // Rebind: Go to Projects gets a second binding on top of its default.
  await openSettings(page, 'shortcuts');
  await expect(page.getByRole('heading', { name: 'Keyboard shortcuts' })).toBeVisible();
  // Search files and code has the same default on the workspace, so look in this row only.
  const goToProjects = page.getByRole('group', { name: 'Go to Projects', exact: true });
  await goToProjects.getByRole('button', { name: 'Add a shortcut for Go to Projects' }).click();
  await expect(
    page.getByRole('textbox', { name: 'Press the keys for the new shortcut' }),
  ).toBeVisible();
  await page.keyboard.press('Control+Shift+J');
  await expect(goToProjects.getByRole('button', { name: `Remove ${CTRL_SHIFT_J}` })).toBeVisible();
  // The default is kept, this is an extra binding rather than a replacement.
  await expect(
    goToProjects.getByRole('button', { name: `Remove ${CTRL_P}`, exact: true }),
  ).toBeVisible();

  const page2 = await relaunch(current);

  // The theme is applied before anything is clicked, straight from the settings file.
  await expect.poll(() => htmlClasses(page2)).toContain('dark');
  expect(current.settingsOnDisk().theme).toBe('dark');

  await openSettings(page2, 'general');
  await expect(
    page2.getByRole('group', { name: 'Theme' }).getByRole('button', { name: /^Dark/ }),
  ).toHaveAttribute('aria-pressed', 'true');

  await openSettings(page2, 'shortcuts');
  await expect(page2.getByRole('button', { name: `Remove ${CTRL_SHIFT_J}` })).toBeVisible();

  // And it still does what it was bound to do.
  await page2.getByRole('link', { name: 'Vault' }).click();
  await expect.poll(() => page2.evaluate(() => window.location.hash)).toBe('#/vault');
  await page2.keyboard.press('Control+Shift+J');
  await expect.poll(() => page2.evaluate(() => window.location.hash)).toBe('#/projects');
});

test('a binding already taken by another command is refused', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  await openSettings(page, 'shortcuts');
  // Only the command palette has Ctrl+K to start with.
  await expect(page.getByRole('button', { name: `Remove ${CTRL_K}` })).toHaveCount(1);

  // Search files and code has the same default on the workspace, so look in this row only.
  const goToProjects = page.getByRole('group', { name: 'Go to Projects', exact: true });
  await goToProjects.getByRole('button', { name: 'Add a shortcut for Go to Projects' }).click();
  // Ctrl+K belongs to the command palette, in the same scope.
  await page.keyboard.press('Control+K');
  await expect(page.getByText(`${CTRL_K} is already used by "Command palette".`)).toBeVisible();
  // Nothing was added, so the combination still has exactly one owner.
  await expect(page.getByRole('button', { name: `Remove ${CTRL_K}` })).toHaveCount(1);
  await expect(
    page.getByRole('textbox', { name: 'Press the keys for the new shortcut' }),
  ).toBeVisible();
});
