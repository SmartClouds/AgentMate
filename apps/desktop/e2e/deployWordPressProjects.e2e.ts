import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { systemTestsEnabled } from '../src/main/deploy/testing/testServerMachines';
import { type LaunchedApp, launchApp } from './app';
import { addActiveTheme, startWordPressSite, type WordPressSite } from './wordpressSite';

/**
 * A WordPress site's themes and plugins put into projects straight from Deploy, end to end, on a
 * real WordPress in Docker with the AgentMate Connector:
 *
 * 1. the site connects with a pasted key;
 * 2. "New project with" on the active theme opens the new project wizard on its items step, with
 *    the theme ticked and the site's name filled in, and makes project A;
 * 3. "Add to a project" pulls a second theme into A's folder;
 * 4. two plain projects, B and C, are made through the bridge;
 * 5. "Move to another project" takes the second theme from A to B, which links B to the site;
 * 6. "Add to another project" puts the first theme in B too, and "Remove from this project" takes
 *    it out again, leaving its files;
 * 7. the Projects section lists A and B with what each syncs, and "Link an existing project"
 *    goes on to the link dialog's items step for C;
 * 8. B is unlinked from the Projects section.
 *
 * Needs AGENTMATE_SYSTEM_TESTS=1 and Docker for Linux containers. The containers are named
 * agentmate-wpc-18996-* and removed in afterAll. With SHOTS_DIR set, each screen worth a design
 * review is also saved there, in the dark and the light theme.
 */

test.skip(!systemTestsEnabled(), 'needs AGENTMATE_SYSTEM_TESTS=1 and Docker for Linux containers');

const PORT = 18_996;
const SITE_LABEL = 'WP projects site';
const ALPHA = 'am-alpha';
const ALPHA_NAME = 'AgentMate Alpha';
const BETA = 'am-beta';
const BETA_NAME = 'AgentMate Beta';
/** A new project from the site is named after it. */
const PROJECT_A = SITE_LABEL;
const PROJECT_B = 'Plain B';
const PROJECT_C = 'Plain C';
const MINUTE = 60_000;
/** A pull into a project, from start to the dialog closing. */
const RUN_TIMEOUT = 3 * MINUTE;
const SHOTS_DIR = process.env.SHOTS_DIR;

const themeFile = (folder: string, slug: string): string =>
  join(folder, 'wp-content', 'themes', slug, 'style.css');

test.describe('WordPress items into projects from Deploy', () => {
  // One story on one site: each step builds on the one before.
  test.describe.configure({ mode: 'serial', retries: 0 });

  let site: WordPressSite | undefined;
  let launched: LaunchedApp | undefined;
  let folderA = '';
  let folderB = '';
  let folderC = '';

  const page = (): Page => {
    if (!launched) throw new Error('The app did not start');
    return launched.page;
  };
  const wp = (): WordPressSite => {
    if (!site) throw new Error('The WordPress site did not start');
    return site;
  };

  /** Saves the screen as it is now, dark and light, when SHOTS_DIR is set. */
  async function shot(name: string): Promise<void> {
    if (!SHOTS_DIR) return;
    const p = page();
    mkdirSync(SHOTS_DIR, { recursive: true });
    await p.screenshot({ path: join(SHOTS_DIR, `${name}-dark.png`), animations: 'disabled' });
    await p.evaluate(() => document.documentElement.classList.remove('dark'));
    await p.screenshot({ path: join(SHOTS_DIR, `${name}-light.png`), animations: 'disabled' });
    await p.evaluate(() => document.documentElement.classList.add('dark'));
  }

  const section = (name: 'Themes and plugins' | 'Projects'): Locator =>
    page().getByRole('navigation', { name: 'Site sections' }).getByRole('button', { name });

  /** The row of the Themes list that shows this theme. */
  const themeRow = (themeName: string): Locator =>
    page()
      .getByRole('list', { name: 'Themes', exact: true })
      .getByRole('listitem')
      .filter({ has: page().getByText(themeName, { exact: true }) })
      .first();

  /** The projects that sync this item, as its row lists them. */
  const projectsWith = (itemName: string): Locator =>
    page().getByRole('list', { name: `Projects with ${itemName}` });

  /** What the app has on record for a project, straight from the bridge. */
  async function projectRecord(
    name: string,
  ): Promise<{ id: string; folderPath: string; wordpress?: { siteId: string; items: unknown[] } }> {
    const found = await page().evaluate(async (projectName) => {
      const api = (
        window as unknown as {
          agentmat: { projects: { list(): Promise<Array<{ name: string }>> } };
        }
      ).agentmat;
      return (await api.projects.list()).find((project) => project.name === projectName) ?? null;
    }, name);
    if (!found) throw new Error(`No project named ${name}`);
    return found as never;
  }

  async function waitForColdStart(): Promise<void> {
    const p = page();
    await p.waitForFunction(() => Boolean((window as { agentmat?: unknown }).agentmat));
    await expect(p.locator('div.absolute.inset-0.z-50.backdrop-blur-xl')).toHaveCount(0, {
      timeout: MINUTE,
    });
  }

  async function openMenu(itemName: string, projectName: string): Promise<Locator> {
    await page()
      .getByRole('button', { name: `More for ${itemName} in ${projectName}` })
      .click();
    const menu = page().getByRole('menu');
    await expect(menu).toBeVisible();
    return menu;
  }

  test.beforeAll(async () => {
    test.setTimeout(15 * MINUTE);
    site = await startWordPressSite(PORT);
    // Beta first so Alpha, made last, is the active theme.
    addActiveTheme(site, BETA, BETA_NAME);
    addActiveTheme(site, ALPHA, ALPHA_NAME);
    launched = await launchApp({ settings: SHOTS_DIR ? { theme: 'dark' } : {} });
    folderA = join(launched.root, 'wp-a');
    folderB = join(launched.root, 'plain-b');
    folderC = join(launched.root, 'plain-c');
    if (SHOTS_DIR) {
      await launched.app.evaluate(({ BrowserWindow }) => {
        BrowserWindow.getAllWindows()[0]?.setSize(1440, 960);
      });
    }
  });

  test.afterAll(async () => {
    test.setTimeout(2 * MINUTE);
    try {
      await launched?.close();
    } finally {
      site?.stop();
    }
  });

  test('connects the site from Deploy with a pasted key', async () => {
    const p = page();
    await p.getByRole('link', { name: 'Deploy' }).click();
    await p.getByRole('button', { name: 'Connect a WordPress site' }).first().click();

    const dialog = p.getByRole('dialog', { name: 'Connect a WordPress site' });
    await dialog.getByLabel('Connection key').fill(wp().keyFor('write'));
    await expect(dialog.getByLabel('What this key connects')).toContainText(wp().url);
    await dialog.getByLabel('Name in AgentMate (optional)').fill(SITE_LABEL);
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: MINUTE });
    await expect(p.getByRole('heading', { name: SITE_LABEL })).toBeVisible();
  });

  test('makes project A from the active theme with "New project with"', async () => {
    const p = page();
    await section('Themes and plugins').click();
    // The first list of the site's items is slow to show in the backgrounded e2e window.
    const alpha = themeRow(ALPHA_NAME);
    await expect(alpha).toContainText('Not in a project yet.', { timeout: 2 * MINUTE });
    await expect(themeRow(BETA_NAME)).toContainText('Not in a project yet.');

    await alpha.getByRole('button', { name: `New project with ${ALPHA_NAME}` }).click();
    const dialog = p.getByRole('dialog', { name: 'New project from a WordPress site' });
    // Straight to the items step: the site is already picked.
    await expect(dialog.getByText('Which themes and plugins?')).toBeVisible();
    const alphaBox = dialog.getByRole('checkbox', { name: new RegExp(`^${ALPHA_NAME}`) });
    await expect(alphaBox).toBeChecked({ timeout: 2 * MINUTE });
    await expect(
      dialog.getByRole('checkbox', { name: new RegExp(`^${BETA_NAME}`) }),
    ).not.toBeChecked();
    await expect(dialog.getByRole('checkbox', { checked: true })).toHaveCount(1);
    await shot('wizard-items');

    await dialog.getByRole('button', { name: 'Next' }).click();
    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(SITE_LABEL);
    await shot('wizard-details');
    await dialog.getByLabel('Folder', { exact: true }).fill(folderA);
    await dialog.getByRole('button', { name: 'Create project' }).click();
    await expect(dialog.getByText(`${SITE_LABEL} is ready`)).toBeVisible({
      timeout: RUN_TIMEOUT,
    });
    // Closing keeps the user on the site's page.
    await p.keyboard.press('Escape');
    await expect(dialog).toBeHidden();

    expect(existsSync(themeFile(folderA, ALPHA))).toBe(true);
    expect(existsSync(themeFile(folderA, BETA))).toBe(false);
    // The row knows about the new project without a reload.
    await expect(projectsWith(ALPHA_NAME)).toContainText(PROJECT_A, { timeout: MINUTE });
    await expect(themeRow(BETA_NAME)).toContainText('Not in a project yet.');
  });

  test('adds a second theme to A with "Add to a project"', async () => {
    const p = page();
    await themeRow(BETA_NAME).getByRole('button', { name: 'Add to a project' }).click();
    const dialog = p.getByRole('dialog', { name: `Add ${BETA_NAME} to a project` });
    await expect(dialog.getByText('New project for this site')).toBeVisible();
    await expect(dialog.getByText('Projects on this site')).toBeVisible();
    const choice = dialog.getByRole('radio', { name: new RegExp(`^${PROJECT_A}`) });
    await expect(choice).toContainText('1 theme or plugin');
    await choice.click();
    await expect(choice).toHaveAttribute('aria-checked', 'true');
    await shot('add-to-project-a');
    await dialog.getByRole('button', { name: 'Add and pull' }).click();
    await expect(dialog).toBeHidden({ timeout: RUN_TIMEOUT });

    await expect.poll(() => existsSync(themeFile(folderA, BETA))).toBe(true);
    await expect(projectsWith(BETA_NAME)).toContainText(PROJECT_A);
    const a = await projectRecord(PROJECT_A);
    expect(a.wordpress?.items).toHaveLength(2);
  });

  test('makes plain projects B and C and reloads', async () => {
    const p = page();
    mkdirSync(folderB, { recursive: true });
    mkdirSync(folderC, { recursive: true });
    await p.evaluate(
      async (plain) => {
        const api = (
          window as unknown as {
            agentmat: { projects: { create(input: unknown): Promise<{ id: string }> } };
          }
        ).agentmat;
        for (const { name, folderPath } of plain) {
          await api.projects.create({
            name,
            folderPath,
            description: '',
            tags: [],
            agentType: 'claude-code',
            notes: '',
            runCommands: [],
          });
        }
      },
      [
        { name: PROJECT_B, folderPath: folderB },
        { name: PROJECT_C, folderPath: folderC },
      ],
    );
    // Made through the bridge, so the cached project list doesn't have them yet.
    await p.reload();
    await waitForColdStart();
    await expect(section('Themes and plugins')).toHaveAttribute('aria-current', /.+/);
    await expect(projectsWith(BETA_NAME)).toContainText(PROJECT_A, { timeout: 2 * MINUTE });
    await shot('items-list');
  });

  test('moves the second theme from A to B', async () => {
    const p = page();
    const menu = await openMenu(BETA_NAME, PROJECT_A);
    await expect(menu.getByRole('menuitem', { name: 'Open project' })).toBeVisible();
    // A holds two items, so Beta can leave it without unlinking it.
    await expect(menu.getByRole('menuitem', { name: 'Remove from this project' })).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: /^Unlink / })).toHaveCount(0);
    await shot('item-menu');
    await menu.getByRole('menuitem', { name: /^Move to another project/ }).click();

    const dialog = p.getByRole('dialog', { name: `Move ${BETA_NAME} to another project` });
    await expect(dialog.getByText('Other projects')).toBeVisible();
    await expect(dialog.getByText('Gets linked to this site')).toBeVisible();
    // A holds it now, so it is not offered.
    await expect(dialog.getByRole('radio', { name: new RegExp(`^${PROJECT_A}`) })).toHaveCount(0);
    const toB = dialog.getByRole('radio', { name: new RegExp(`^${PROJECT_B}`) });
    await toB.click();
    await expect(
      dialog.getByText(`${PROJECT_B} becomes a WordPress project linked to ${SITE_LABEL}.`),
    ).toBeVisible();
    await shot('move-dialog');
    await dialog.getByRole('button', { name: 'Move', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: RUN_TIMEOUT });

    const withBeta = projectsWith(BETA_NAME);
    await expect(withBeta).toContainText(PROJECT_B);
    await expect(withBeta.getByRole('listitem')).toHaveCount(1);
    await expect(withBeta).not.toContainText(PROJECT_A);

    const b = await projectRecord(PROJECT_B);
    expect(b.wordpress?.items).toEqual([{ kind: 'theme', slug: BETA }]);
    const a = await projectRecord(PROJECT_A);
    expect(a.wordpress?.items).toEqual([{ kind: 'theme', slug: ALPHA }]);
    expect(b.wordpress?.siteId).toBe(a.wordpress?.siteId);
    expect(existsSync(themeFile(folderB, BETA))).toBe(true);
    // Moving never deletes: A's copy stays in its folder.
    expect(existsSync(themeFile(folderA, BETA))).toBe(true);
  });

  test('adds the first theme to B as well, then removes it from B', async () => {
    const p = page();
    await themeRow(ALPHA_NAME).getByRole('button', { name: 'Add to another project' }).click();
    const dialog = p.getByRole('dialog', { name: `Add ${ALPHA_NAME} to a project` });
    const toB = dialog.getByRole('radio', { name: new RegExp(`^${PROJECT_B}`) });
    await expect(toB).toContainText('1 theme or plugin');
    await expect(dialog.getByRole('radio', { name: new RegExp(`^${PROJECT_C}`) })).toBeVisible();
    await toB.click();
    await shot('add-to-another-project');
    await dialog.getByRole('button', { name: 'Add and pull' }).click();
    await expect(dialog).toBeHidden({ timeout: RUN_TIMEOUT });
    await expect(projectsWith(ALPHA_NAME).getByRole('listitem')).toHaveCount(2);
    expect(existsSync(themeFile(folderB, ALPHA))).toBe(true);

    // A has only Alpha, so its menu offers an unlink in place of a remove.
    let menu = await openMenu(ALPHA_NAME, PROJECT_A);
    await expect(
      menu.getByRole('menuitem', { name: `Unlink ${PROJECT_A} from this site` }),
    ).toBeVisible();
    await expect(menu.getByRole('menuitem', { name: 'Remove from this project' })).toHaveCount(0);
    await shot('item-menu-last-item');
    await p.keyboard.press('Escape');
    await expect(menu).toBeHidden();

    menu = await openMenu(ALPHA_NAME, PROJECT_B);
    await menu.getByRole('menuitem', { name: 'Remove from this project' }).click();
    const confirm = p.getByRole('dialog', { name: `Stop syncing ${ALPHA} in ${PROJECT_B}?` });
    await confirm.getByRole('button', { name: 'Stop syncing' }).click();
    await expect(confirm).toBeHidden();

    const withAlpha = projectsWith(ALPHA_NAME);
    await expect(withAlpha.getByRole('listitem')).toHaveCount(1, { timeout: MINUTE });
    await expect(withAlpha).toContainText(PROJECT_A);
    await expect(withAlpha).not.toContainText(PROJECT_B);
    const b = await projectRecord(PROJECT_B);
    expect(b.wordpress?.items).toEqual([{ kind: 'theme', slug: BETA }]);
    // Its files stay in B's folder.
    expect(existsSync(themeFile(folderB, ALPHA))).toBe(true);
  });

  test('lists both projects in Projects and links C up to its items step', async () => {
    const p = page();
    await section('Projects').click();
    const list = p.getByRole('list', { name: 'Projects on this site' });
    await expect(list).toBeVisible();
    const chipsA = p.getByRole('list', { name: `Themes and plugins in ${PROJECT_A}` });
    const chipsB = p.getByRole('list', { name: `Themes and plugins in ${PROJECT_B}` });
    await expect(chipsA).toContainText(ALPHA_NAME, { timeout: MINUTE });
    await expect(chipsA.getByRole('listitem')).toHaveCount(1);
    await expect(chipsB).toContainText(BETA_NAME);
    await expect(chipsB.getByRole('listitem')).toHaveCount(1);
    await expect(list).not.toContainText(PROJECT_C);
    await expect(p.getByRole('button', { name: `Open ${PROJECT_A}` })).toBeVisible();
    await expect(p.getByRole('button', { name: `Pull into ${PROJECT_B}` })).toBeVisible();
    await shot('projects-section');

    await p.getByRole('button', { name: 'Link an existing project' }).click();
    const picker = p.getByRole('dialog', { name: 'Link an existing project' });
    const choices = picker.getByRole('radiogroup', { name: 'Projects to link' });
    // Only projects linked to no site are offered.
    await expect(choices.getByRole('radio')).toHaveCount(1);
    const toC = choices.getByRole('radio', { name: new RegExp(`^${PROJECT_C}`) });
    await toC.click();
    await expect(toC).toHaveAttribute('aria-checked', 'true');
    await shot('link-picker');
    await picker.getByRole('button', { name: 'Next' }).click();
    await expect(picker).toBeHidden();

    const link = p.getByRole('dialog', { name: 'Make this a WordPress project' });
    await expect(link.getByText('Which themes and plugins?')).toBeVisible();
    await expect(link.getByRole('checkbox', { name: new RegExp(`^${ALPHA_NAME}`) })).toBeChecked({
      timeout: MINUTE,
    });
    await expect(link.getByRole('button', { name: 'Link', exact: true })).toBeEnabled();
    await shot('link-dialog-items');
    await p.keyboard.press('Escape');
    await expect(link).toBeHidden();

    const c = await projectRecord(PROJECT_C);
    expect(c.wordpress).toBeUndefined();
    expect(existsSync(themeFile(folderC, ALPHA))).toBe(false);
  });

  test('unlinks B from the Projects section and keeps its files', async () => {
    const p = page();
    await p.getByRole('button', { name: `More actions for ${PROJECT_B}` }).click();
    await p.getByRole('menuitem', { name: 'Unlink from this site' }).click();
    const confirm = p.getByRole('dialog', { name: 'Unlink this project from the site?' });
    await confirm.getByRole('button', { name: 'Unlink', exact: true }).click();
    await expect(confirm).toBeHidden();

    const list = p.getByRole('list', { name: 'Projects on this site' });
    await expect(list).not.toContainText(PROJECT_B, { timeout: MINUTE });
    await expect(list).toContainText(PROJECT_A);
    const b = await projectRecord(PROJECT_B);
    expect(b.wordpress).toBeUndefined();
    expect(existsSync(themeFile(folderB, BETA))).toBe(true);

    await section('Themes and plugins').click();
    await expect(themeRow(BETA_NAME)).toContainText('Not in a project yet.');
    await expect(projectsWith(ALPHA_NAME)).toContainText(PROJECT_A);
  });
});
