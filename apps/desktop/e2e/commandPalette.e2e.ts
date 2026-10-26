import { expect, type Locator, type Page, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';

/**
 * The command palette as a way to get around: its shortcut opens and closes it, typing narrows
 * the list to one page that Enter then opens, and a project that exists only in this run's
 * profile is findable by name and opens its page.
 */

const PALETTE_PLACEHOLDER = 'Search projects, history, skills…';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

function paletteInput(page: Page): Locator {
  return page.getByPlaceholder(PALETTE_PLACEHOLDER);
}

/**
 * Presses the shortcut until the palette is up. The shell binds it in an effect, so a press
 * fired in the first moments after launch can land before the listener exists.
 */
async function openPalette(page: Page): Promise<Locator> {
  const input = paletteInput(page);
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  await expect(async () => {
    await page.keyboard.press('Control+K');
    await expect(input).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  return input;
}

test('the shortcut opens the palette, and Enter opens the page that is left', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const input = await openPalette(page);

  // Every page is offered before anything is typed.
  await expect(page.getByRole('option', { name: 'Dashboard' })).toBeVisible();
  await expect(page.getByRole('option', { name: 'Settings' })).toBeVisible();

  // The same shortcut closes it again.
  await page.keyboard.press('Control+K');
  await expect(input).toBeHidden();

  await page.keyboard.press('Control+K');
  await expect(input).toBeVisible();
  const before = await page.getByRole('option').count();

  await page.keyboard.type('vault');
  const option = page.getByRole('option', { name: 'Vault' });
  await expect(option).toBeVisible();
  // Typing narrowed the list, and the best match is the one Enter will take.
  await expect.poll(() => page.getByRole('option').count()).toBeLessThan(before);
  await expect(option).toHaveAttribute('aria-selected', 'true');

  await page.keyboard.press('Enter');
  await expect(input).toBeHidden();
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/vault');
  await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
});

test('a project is findable by name and opens its page', async () => {
  launched = await launchApp({ settings: {} });
  const { page, projectDir } = launched;
  const projectId = await createProject(launched);
  // A project created through IPC is not in the renderer's cached list, which is what the palette
  // searches, so the window is reloaded the way openWorkspace does it.
  await page.reload();
  await page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));

  const input = await openPalette(page);
  await page.keyboard.type('e2e project');

  const result = page
    .getByRole('option')
    .filter({ hasText: projectDir })
    .filter({ hasText: 'e2e project' });
  await expect(result).toHaveCount(1);
  await result.click();

  await expect(input).toBeHidden();
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/projects/${projectId}`);
  await expect(page.getByRole('heading', { level: 1, name: 'e2e project' })).toBeVisible();
});

test('nothing matching says so, and Escape closes the palette', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  const input = await openPalette(page);
  await page.keyboard.type('zzz-nothing-matches-this');
  await expect(page.getByText('No results found.')).toBeVisible();
  await expect(page.getByRole('option')).toHaveCount(0);

  await page.keyboard.press('Escape');
  await expect(input).toBeHidden();
  // Closing dropped the query, so the next open starts clean.
  await page.keyboard.press('Control+K');
  await expect(input).toHaveValue('');
});
