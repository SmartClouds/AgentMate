import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { systemTestsEnabled } from '../src/main/deploy/testing/testServerMachines';
import { type LaunchedApp, launchApp } from './app';
import {
  addActiveTheme,
  existsOnSite,
  siteFile,
  startWordPressSite,
  type WordPressSite,
} from './wordpressSite';

/**
 * Leaving files out of a WordPress deploy, and deploying a theme or plugin the site does not have
 * yet, end to end on a real WordPress in Docker with the Runova Connector:
 *
 * 1. a project is made from the site's theme, then given local changes: edits, new files, a
 *    folder the theme's .gitignore names, and agent folders;
 * 2. the review lists what would go, and shows what git ignores and what starts with .claude or
 *    .runova under "Left out";
 * 3. a folder is ignored from a file's menu, and two ticked files from the selection bar;
 * 4. the choices are saved on the project, still there when the review opens again, and one is
 *    taken back from the list under the review;
 * 5. the deploy sends only what is left, and leaves the ignored files off the site;
 * 6. a new plugin made in the project is added from Deploy's "New theme or plugin", reviewed and
 *    created on the site.
 *
 * Needs RUNOVA_SYSTEM_TESTS=1 and Docker for Linux containers. The containers are named
 * runova-wpc-18997-* and removed in afterAll. With SHOTS_DIR set, each screen worth a design
 * review is also saved there, in the dark and the light theme.
 */

test.skip(!systemTestsEnabled(), 'needs RUNOVA_SYSTEM_TESTS=1 and Docker for Linux containers');

const PORT = 18_997;
const SHOTS_DIR = process.env.SHOTS_DIR;
const MINUTE = 60_000;
const SITE_LABEL = 'WP ignore site';
const PROJECT_NAME = 'WP ignore project';
const SITE_THEMES = '/var/www/html/wp-content/themes/shop';
const SITE_PLUGINS = '/var/www/html/wp-content/plugins';
const THEME_ROOT = 'wp-content/themes/shop';

test.describe('Ignoring files in a WordPress deploy', () => {
  test.describe.configure({ mode: 'serial', retries: 0 });

  let wp: WordPressSite | undefined;
  let launched: LaunchedApp | undefined;
  let projectId = '';
  let folder = '';

  const page = (): Page => {
    if (!launched) throw new Error('The app did not start');
    return launched.page;
  };
  const site = (): WordPressSite => {
    if (!wp) throw new Error('The WordPress site did not start');
    return wp;
  };

  async function shot(name: string): Promise<void> {
    if (!SHOTS_DIR) return;
    const p = page();
    mkdirSync(SHOTS_DIR, { recursive: true });
    await p.screenshot({ path: join(SHOTS_DIR, `${name}-dark.png`), animations: 'disabled' });
    await p.evaluate(() => document.documentElement.classList.remove('dark'));
    await p.screenshot({ path: join(SHOTS_DIR, `${name}-light.png`), animations: 'disabled' });
    await p.evaluate(() => document.documentElement.classList.add('dark'));
  }

  function write(path: string, content: string): void {
    const full = join(folder, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  }

  async function waitForColdStart(): Promise<void> {
    const p = page();
    await p.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
    await expect(p.locator('div.absolute.inset-0.z-50.backdrop-blur-xl')).toHaveCount(0, {
      timeout: MINUTE,
    });
  }

  /** The project as the app keeps it, straight from the bridge. */
  async function projectRecord(): Promise<{ wordpress?: { ignore?: Record<string, string[]> } }> {
    return page().evaluate(async (id) => {
      const api = (
        window as unknown as {
          runova: { projects: { list(): Promise<Array<{ id: string }>> } };
        }
      ).runova;
      return (await api.projects.list()).find((project) => project.id === id) ?? {};
    }, projectId);
  }

  const reviewDialog = (): Locator =>
    page().getByRole('dialog', { name: new RegExp(`Deploy to ${SITE_LABEL}`) });

  async function openReview(): Promise<Locator> {
    await page()
      .getByRole('button', { name: /Review and deploy/ })
      .click();
    const dialog = reviewDialog();
    await expect(dialog.getByRole('button', { name: /Check again/ })).toBeVisible({
      timeout: 2 * MINUTE,
    });
    return dialog;
  }

  /** The checkbox that only a row of the change list has. */
  const row = (dialog: Locator, path: string): Locator =>
    dialog.getByRole('checkbox', { name: `Select ${path}`, exact: true });

  test.beforeAll(async () => {
    test.setTimeout(20 * MINUTE);
    wp = await startWordPressSite(PORT);
    addActiveTheme(wp, 'shop', 'Shop');
    launched = await launchApp({ settings: SHOTS_DIR ? { theme: 'dark' } : {} });
    folder = mkdtempSync(join(launched.root, 'wp-'));
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
      wp?.stop();
    }
  });

  test('makes a project from the site and changes some files in it', async () => {
    test.setTimeout(5 * MINUTE);
    const p = page();
    await waitForColdStart();
    projectId = await p.evaluate(
      async ({ key, label, folderPath, name }) => {
        const api = (
          window as unknown as {
            runova: {
              deployWordPress: {
                connect(input: unknown): Promise<{ id: string }>;
                createProject(input: unknown): Promise<{ id: string }>;
              };
            };
          }
        ).runova;
        const connected = await api.deployWordPress.connect({ connectionKey: key, label });
        const project = await api.deployWordPress.createProject({
          operationId: 'op-e2e-ignore-0001',
          siteId: connected.id,
          items: [{ kind: 'theme', slug: 'shop' }],
          folderPath,
          name,
          agentType: 'claude-code',
        });
        return project.id;
      },
      { key: site().keyFor('write'), label: SITE_LABEL, folderPath: folder, name: PROJECT_NAME },
    );

    write(`${THEME_ROOT}/style.css`, '/*\nTheme Name: Shop 2\n*/\n');
    write(`${THEME_ROOT}/inc/setup.php`, '<?php // setup 2\n');
    write(`${THEME_ROOT}/inc/new.php`, '<?php // new\n');
    write(`${THEME_ROOT}/src/app.ts`, 'export const app = 1;\n');
    write(`${THEME_ROOT}/src/util.ts`, 'export const util = 1;\n');
    write(`${THEME_ROOT}/assets/app.js.map`, '{}\n');
    write(`${THEME_ROOT}/docs/readme.md`, '# docs\n');
    write(`${THEME_ROOT}/vendor/lib.php`, '<?php // lib\n');
    write(`${THEME_ROOT}/.gitignore`, 'vendor/\n');
    write(`${THEME_ROOT}/.claude-skills/a.md`, 'skill\n');
    write(`${THEME_ROOT}/.runova-cache/b.json`, '{}\n');

    await p.reload();
    await waitForColdStart();
    await p.evaluate((id) => {
      window.location.hash = `#/projects/${id}?tab=wordpress`;
    }, projectId);
    await expect(p.getByRole('region', { name: 'Linked site' })).toBeVisible({ timeout: MINUTE });
    await expect(p.getByRole('region', { name: 'Ignored files' })).toBeVisible();
    await shot('project-section');
  });

  test('lists what would go, and what git and the agent folders keep out', async () => {
    const dialog = await openReview();
    for (const path of [
      'style.css',
      'inc/setup.php',
      'inc/new.php',
      'src/app.ts',
      'src/util.ts',
      'assets/app.js.map',
      'docs/readme.md',
    ]) {
      await expect(row(dialog, path)).toBeVisible();
    }
    // Neither the git-ignored folder nor an agent folder is among the changes.
    await expect(row(dialog, 'vendor/lib.php')).toHaveCount(0);
    await expect(row(dialog, '.claude-skills/a.md')).toHaveCount(0);

    const leftOut = dialog.getByRole('region', { name: 'Left out' });
    await expect(leftOut).toContainText('vendor/');
    await expect(leftOut).toContainText('.claude-skills/a.md');
    await expect(leftOut).toContainText('.runova-cache/b.json');
    await shot('review');
  });

  test('ignores a folder from a file menu, and the choice is saved', async () => {
    const dialog = reviewDialog();
    await dialog.getByRole('button', { name: 'Ignore options for src/app.ts' }).click();
    await page().getByRole('menuitem', { name: 'Ignore the folder src/' }).click();

    await expect(row(dialog, 'src/app.ts')).toHaveCount(0, { timeout: MINUTE });
    await expect(row(dialog, 'src/util.ts')).toHaveCount(0);
    await expect(row(dialog, 'inc/new.php')).toBeVisible();
    await expect(dialog.getByRole('button', { name: 'Stop ignoring src/ in shop' })).toBeVisible();
    expect((await projectRecord()).wordpress?.ignore).toEqual({ 'theme:shop': ['/src/'] });
    await shot('after-folder-ignored');
  });

  test('ignores a series of ticked files from the selection bar', async () => {
    const dialog = reviewDialog();
    await row(dialog, 'docs/readme.md').click();
    await row(dialog, 'assets/app.js.map').click();
    const bar = dialog.getByRole('region', { name: 'Selected files' });
    await expect(bar).toContainText('2 files selected');
    await shot('two-files-selected');

    await bar.getByRole('button', { name: 'Ignore selected files' }).click();
    await expect(row(dialog, 'docs/readme.md')).toHaveCount(0, { timeout: MINUTE });
    await expect(row(dialog, 'assets/app.js.map')).toHaveCount(0);
    await expect(bar).toHaveCount(0);
    // Saved in the order the review lists the files, not the order they were ticked.
    expect((await projectRecord()).wordpress?.ignore).toEqual({
      'theme:shop': ['/src/', '/assets/app.js.map', '/docs/readme.md'],
    });
  });

  test('keeps the choices for the next review, and takes one back', async () => {
    const p = page();
    await p.keyboard.press('Escape');
    await expect(reviewDialog()).toBeHidden();

    const dialog = await openReview();
    await expect(row(dialog, 'inc/new.php')).toBeVisible();
    await expect(row(dialog, 'src/app.ts')).toHaveCount(0);
    await expect(row(dialog, 'docs/readme.md')).toHaveCount(0);

    await dialog.getByRole('button', { name: 'Stop ignoring docs/readme.md in shop' }).click();
    await expect(row(dialog, 'docs/readme.md')).toBeVisible({ timeout: MINUTE });
    await expect(row(dialog, 'src/app.ts')).toHaveCount(0);
    expect((await projectRecord()).wordpress?.ignore).toEqual({
      'theme:shop': ['/src/', '/assets/app.js.map'],
    });
    await shot('after-take-back');
  });

  test('deploys only what is left, and keeps the ignored files off the site', async () => {
    test.setTimeout(5 * MINUTE);
    const dialog = reviewDialog();
    await dialog.getByRole('button', { name: /Continue/ }).click();
    await dialog.getByRole('button', { name: /Deploy now/ }).click();
    await expect(dialog.getByText('Deployed')).toBeVisible({ timeout: 3 * MINUTE });

    expect(siteFile(site(), `${SITE_THEMES}/inc/new.php`)).toBe('<?php // new');
    expect(siteFile(site(), `${SITE_THEMES}/docs/readme.md`)).toBe('# docs');
    expect(siteFile(site(), `${SITE_THEMES}/inc/setup.php`)).toBe('<?php // setup 2');
    expect(existsOnSite(site(), `${SITE_THEMES}/src`)).toBe(false);
    expect(existsOnSite(site(), `${SITE_THEMES}/assets/app.js.map`)).toBe(false);
    expect(existsOnSite(site(), `${SITE_THEMES}/vendor`)).toBe(false);
    expect(existsOnSite(site(), `${SITE_THEMES}/.claude-skills`)).toBe(false);
    expect(existsOnSite(site(), `${SITE_THEMES}/.runova-cache`)).toBe(false);
    await dialog.getByRole('button', { name: 'Done' }).click();
  });

  test('deploys a new plugin from Deploy, reviews it first and creates it on the site', async () => {
    test.setTimeout(5 * MINUTE);
    const p = page();
    write('wp-content/plugins/fresh/fresh.php', '<?php\n/*\nPlugin Name: Fresh\n*/\n');
    write('wp-content/plugins/fresh/inc/a.php', '<?php // a\n');

    await p.getByRole('link', { name: 'Deploy' }).click();
    await p.getByText(SITE_LABEL, { exact: true }).first().click();
    await p
      .getByRole('navigation', { name: 'Site sections' })
      .getByRole('button', { name: 'Themes and plugins' })
      .click();
    await p.getByRole('button', { name: 'New theme or plugin' }).click();

    const dialog = p.getByRole('dialog', { name: 'New theme or plugin' });
    await dialog.getByRole('radio', { name: new RegExp(PROJECT_NAME) }).click();
    await dialog.getByRole('button', { name: 'Next' }).click();
    const box = dialog.getByRole('checkbox', { name: /fresh/ });
    await expect(box).toBeVisible({ timeout: MINUTE });
    await shot('new-plugin-folders');
    await box.click();
    await dialog.getByRole('button', { name: 'Add and review deploy' }).click();

    const review = reviewDialog();
    await expect(row(review, 'fresh.php')).toBeVisible({ timeout: 2 * MINUTE });
    await expect(row(review, 'inc/a.php')).toBeVisible();
    await expect(review.getByText('Adds a new theme or plugin folder to the site')).toBeVisible();
    await shot('new-plugin-review');
    await review.getByRole('button', { name: /Continue/ }).click();
    await review.getByRole('button', { name: /Deploy now/ }).click();
    await expect(review.getByText('Deployed')).toBeVisible({ timeout: 3 * MINUTE });

    expect(existsOnSite(site(), `${SITE_PLUGINS}/fresh/fresh.php`)).toBe(true);
    expect(siteFile(site(), `${SITE_PLUGINS}/fresh/inc/a.php`)).toBe('<?php // a');
  });
});
