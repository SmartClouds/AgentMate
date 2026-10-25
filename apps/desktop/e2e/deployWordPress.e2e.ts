import { existsSync, mkdirSync, writeFileSync } from 'node:fs';
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
 * WordPress through the built app, end to end (E19 to E21): a real WordPress in Docker with the
 * AgentMate Connector plugin, connected from Deploy with a key, turned into a project from
 * Projects, then deployed to from the project's WordPress section.
 *
 * 1. the site connects with a pasted key and its overview shows the active theme;
 * 2. a project pulls the theme into a new folder;
 * 3. a change deploys, while agent settings and AgentMate files in the theme stay on this computer;
 * 4. a PHP syntax error is refused before the site changes;
 * 5. a fatal error rolls back on its own;
 * 6. the Workspace header has Deploy in place of Tag a version, and it deploys the project;
 * 7. a good deploy is rolled back by hand from Deploy > the site > Deploys.
 *
 * Every request is signed with Ed25519 in the main process, so this also proves the signing works
 * under Electron's BoringSSL, which the plain-Node unit tests can't. Needs AGENTMATE_SYSTEM_TESTS=1
 * and Docker for Linux containers; the containers are named agentmate-wpc-18998-* and removed in
 * afterAll.
 */

test.skip(!systemTestsEnabled(), 'needs AGENTMATE_SYSTEM_TESTS=1 and Docker for Linux containers');

const PORT = 18_998;
const SITE_LABEL = 'WP e2e site';
const THEME = 'am-int';
const THEME_NAME = 'AgentMate Int';
const SITE_ROOT = '/var/www/html';
const SITE_SETUP = `${SITE_ROOT}/wp-content/themes/${THEME}/inc/setup.php`;
const SETUP_V2 = '<?php // setup v2';
const SETUP_V3 = '<?php // setup v3';
const SETUP_V4 = '<?php // setup v4';
const MINUTE = 60_000;
/** A pull, a deploy or a rollback, health checks included. */
const RUN_TIMEOUT = 3 * MINUTE;

/** Agent files inside the theme: listed as left out, never sent. */
const THEME_AGENT_FILES = ['.claude/settings.json', 'AGENTS.md', '.agentmate/hooks/x.sh'];
/** Agent files at the project root, outside every synced item, so not even walked. */
const ROOT_AGENT_FILES = ['.claude/settings.json', 'AGENTS.md'];

test.describe('WordPress sites in Deploy and Projects', () => {
  // One story on one site: each step builds on the one before, and a retry would mean a new
  // WordPress and a new pairing.
  test.describe.configure({ mode: 'serial', retries: 0 });

  let site: WordPressSite | undefined;
  let launched: LaunchedApp | undefined;
  let folder = '';

  const page = (): Page => {
    if (!launched) throw new Error('The app did not start');
    return launched.page;
  };
  const wp = (): WordPressSite => {
    if (!site) throw new Error('The WordPress site did not start');
    return site;
  };
  /** Writes a file into the project folder, `path` relative to its root. */
  const writeLocal = (path: string, content: string): void => {
    const full = join(folder, ...path.split('/'));
    mkdirSync(dirname(full), { recursive: true });
    writeFileSync(full, content);
  };
  const writeSetup = (content: string): void =>
    writeLocal(`wp-content/themes/${THEME}/inc/setup.php`, content);

  test.beforeAll(async () => {
    test.setTimeout(15 * MINUTE);
    site = await startWordPressSite(PORT);
    addActiveTheme(site, THEME, THEME_NAME);
    launched = await launchApp({ settings: {} });
    folder = join(launched.root, 'wp-project');
  });

  test.afterAll(async () => {
    test.setTimeout(2 * MINUTE);
    try {
      await launched?.close();
    } finally {
      site?.stop();
    }
  });

  /** Opens Review and deploy from the project's WordPress section and waits for the plan. */
  async function openReview(): Promise<Locator> {
    await page()
      .getByRole('region', { name: 'Linked site' })
      .getByRole('button', { name: 'Review and deploy' })
      .click();
    const dialog = page().getByRole('dialog', { name: `Deploy to ${SITE_LABEL}` });
    await expect(dialog.getByText(/^\d+ files? to upload/)).toBeVisible({ timeout: MINUTE });
    return dialog;
  }

  /** The review lists setup.php as the only change; continue and deploy it. */
  async function deploySetupChange(dialog: Locator): Promise<void> {
    await expect(dialog.getByText(/^1 file to upload.*, 0 to delete\.$/)).toBeVisible();
    const changes = dialog.locator('button[aria-pressed]');
    await expect(changes).toHaveCount(1);
    await expect(changes).toContainText('inc/setup.php');
    await dialog.getByRole('button', { name: 'Continue' }).click();
    await dialog.getByRole('button', { name: 'Deploy now' }).click();
  }

  async function closeDeployDialog(dialog: Locator): Promise<void> {
    await dialog.getByRole('button', { name: 'Done', exact: true }).click();
    await expect(dialog).toBeHidden();
  }

  test('connects the site from Deploy with a pasted key', async () => {
    const p = page();
    await p.getByRole('link', { name: 'Deploy' }).click();
    await p.getByRole('button', { name: 'Connect a WordPress site' }).first().click();

    const dialog = p.getByRole('dialog', { name: 'Connect a WordPress site' });
    // A key works once, for 15 minutes, so it is made right before it is pasted.
    await dialog.getByLabel('Connection key').fill(wp().keyFor('write'));
    const what = dialog.getByLabel('What this key connects');
    await expect(what).toContainText(wp().url);
    // localhost needs no plain-HTTP opt-in.
    await expect(dialog.getByText('Plain HTTP to this computer is fine')).toBeVisible();
    await expect(dialog.getByText('Allow plain HTTP for this site')).toHaveCount(0);
    await dialog.getByLabel('Name in AgentMate (optional)').fill(SITE_LABEL);
    await dialog.getByRole('button', { name: 'Connect', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: MINUTE });

    const rail = p.getByRole('list', { name: 'WordPress sites' });
    await expect(rail.getByRole('button', { name: new RegExp(SITE_LABEL) })).toBeVisible();
    await expect(p.getByRole('heading', { name: SITE_LABEL })).toBeVisible();
    await expect(p.locator('dt:text-is("Active theme") + dd')).toContainText(THEME, {
      timeout: MINUTE,
    });
  });

  test('creates a WordPress project that pulls the theme', async () => {
    const p = page();
    await p.getByRole('link', { name: 'Projects' }).click();
    await p.getByRole('button', { name: 'More kinds of project' }).click();
    await p.getByRole('menuitem', { name: 'WordPress site' }).click();

    const dialog = p.getByRole('dialog', { name: 'New project from a WordPress site' });
    await dialog
      .getByRole('list', { name: 'Connected sites' })
      .getByRole('button', { name: new RegExp(SITE_LABEL) })
      .click();
    await dialog.getByRole('button', { name: 'Next' }).click();

    // The active theme is ticked for the user. This first list of the site's items has taken up to
    // half a minute to show in the backgrounded e2e window, though the site answers in milliseconds.
    await expect(dialog.getByRole('checkbox', { name: new RegExp(THEME_NAME) })).toBeChecked({
      timeout: 2 * MINUTE,
    });
    await dialog.getByRole('button', { name: 'Next' }).click();

    await expect(dialog.getByLabel('Name', { exact: true })).toHaveValue(SITE_LABEL);
    await dialog.getByLabel('Folder', { exact: true }).fill(folder);
    await dialog.getByRole('button', { name: 'Create project' }).click();

    await expect(dialog.getByText(`${SITE_LABEL} is ready`)).toBeVisible({
      timeout: RUN_TIMEOUT,
    });
    await dialog.getByRole('button', { name: 'Open the project' }).click();
    await expect(dialog).toBeHidden();
    await expect.poll(() => p.evaluate(() => window.location.hash)).toMatch(/^#\/projects\/[^/?]+/);

    expect(existsSync(join(folder, 'wp-content', 'themes', THEME, 'style.css'))).toBe(true);

    await p
      .getByRole('navigation', { name: 'Project sections' })
      .getByRole('button', { name: /WordPress/ })
      .click();
    await expect(p.getByRole('region', { name: 'Linked site' })).toContainText(SITE_LABEL);
  });

  test('deploys a theme change and keeps agent files on this computer', async () => {
    writeSetup(`${SETUP_V2}\n`);
    for (const path of THEME_AGENT_FILES) {
      writeLocal(`wp-content/themes/${THEME}/${path}`, 'local only\n');
    }
    for (const path of ROOT_AGENT_FILES) writeLocal(path, 'local only\n');

    const dialog = await openReview();
    const agentFiles = dialog.getByRole('list', {
      name: 'Stays on this computer: agent settings and AgentMate files',
    });
    await expect(agentFiles).toContainText('.claude');
    await expect(agentFiles).toContainText('AGENTS.md');
    await expect(agentFiles).toContainText('.agentmate');

    await deploySetupChange(dialog);
    await expect(dialog.getByRole('status').filter({ hasText: 'Deployed' })).toBeVisible({
      timeout: RUN_TIMEOUT,
    });
    await closeDeployDialog(dialog);

    expect(siteFile(wp(), SITE_SETUP)).toBe(SETUP_V2);
    const themeOnSite = `${SITE_ROOT}/wp-content/themes/${THEME}`;
    for (const path of [...THEME_AGENT_FILES, '.claude', '.agentmate']) {
      expect(existsOnSite(wp(), `${themeOnSite}/${path}`), path).toBe(false);
    }
    for (const path of [...ROOT_AGENT_FILES, '.claude']) {
      expect(existsOnSite(wp(), `${SITE_ROOT}/${path}`), path).toBe(false);
    }
  });

  test('refuses a PHP syntax error before the site changes', async () => {
    writeSetup('<?php function broken( {\n');

    const dialog = await openReview();
    await deploySetupChange(dialog);
    const errors = dialog.getByRole('list', { name: 'Syntax errors' });
    await expect(errors).toContainText(`wp-content/themes/${THEME}/inc/setup.php`, {
      timeout: RUN_TIMEOUT,
    });
    await expect(errors).toContainText('line 1');
    await closeDeployDialog(dialog);

    expect(siteFile(wp(), SITE_SETUP)).toBe(SETUP_V2);
  });

  test('rolls back on its own when the change breaks the site', async () => {
    writeSetup('<?php agentmate_e2e_missing();\n');

    const dialog = await openReview();
    await deploySetupChange(dialog);
    await expect(dialog.getByRole('status').filter({ hasText: 'Rolled back' })).toBeVisible({
      timeout: RUN_TIMEOUT,
    });
    await closeDeployDialog(dialog);

    expect(siteFile(wp(), SITE_SETUP)).toBe(SETUP_V2);
  });

  test('deploys from the Workspace header, where Tag a version would be', async () => {
    const p = page();
    writeSetup(`${SETUP_V4}
`);

    const projectId = await p.evaluate(async (projectFolder) => {
      const api = (
        window as unknown as {
          agentmat: { projects: { list(): Promise<Array<{ id: string; folderPath: string }>> } };
        }
      ).agentmat;
      const same = (path: string): string => path.replace(/[\\/]+$/, '').toLowerCase();
      const projects = await api.projects.list();
      return (
        projects.find((project) => same(project.folderPath) === same(projectFolder))?.id ?? null
      );
    }, folder);
    expect(projectId).not.toBeNull();
    await p.evaluate((id) => {
      location.hash = `#/workspace/${id}`;
    }, projectId);

    const deploy = p.getByRole('button', { name: `Deploy to ${SITE_LABEL}` });
    await expect(deploy).toBeVisible({ timeout: MINUTE });
    await expect(deploy).toHaveText('Deploy');
    await expect(p.getByRole('button', { name: 'Tag a version' })).toHaveCount(0);

    await deploy.click();
    const dialog = p.getByRole('dialog', { name: `Deploy to ${SITE_LABEL}` });
    await expect(dialog.getByText(/^\d+ files? to upload/)).toBeVisible({ timeout: MINUTE });
    await deploySetupChange(dialog);
    await expect(dialog.getByRole('status').filter({ hasText: 'Deployed' })).toBeVisible({
      timeout: RUN_TIMEOUT,
    });
    await closeDeployDialog(dialog);

    expect(siteFile(wp(), SITE_SETUP)).toBe(SETUP_V4);
    // The result was seen in the dialog, so the header is back to plain Deploy, with no dot.
    await expect(deploy).toHaveText('Deploy');
    await expect(p.getByTestId('deploy-result-dot')).toHaveCount(0);

    // Back to the project's WordPress section, where the next step starts.
    await p.getByRole('button', { name: 'Project details' }).click();
    await p
      .getByRole('navigation', { name: 'Project sections' })
      .getByRole('button', { name: /WordPress/ })
      .click();
    await expect(p.getByRole('region', { name: 'Linked site' })).toContainText(SITE_LABEL);
  });

  test('rolls a good deploy back by hand from Deploy', async () => {
    const p = page();
    writeSetup(`${SETUP_V3}\n`);

    const dialog = await openReview();
    await deploySetupChange(dialog);
    await expect(dialog.getByRole('status').filter({ hasText: 'Deployed' })).toBeVisible({
      timeout: RUN_TIMEOUT,
    });
    await closeDeployDialog(dialog);
    expect(siteFile(wp(), SITE_SETUP)).toBe(SETUP_V3);

    await p.getByRole('link', { name: 'Deploy' }).click();
    await p
      .getByRole('list', { name: 'WordPress sites' })
      .getByRole('button', { name: new RegExp(SITE_LABEL) })
      .click();
    await p
      .getByRole('navigation', { name: 'Site sections' })
      .getByRole('button', { name: 'Deploys' })
      .click();

    // Newest first: the v3 deploy is the first one that can still be rolled back.
    const deploys = p.getByRole('list', { name: 'Deploys' });
    const newest = deploys.getByRole('listitem').first();
    await expect(newest.getByRole('button', { name: /^Roll back / })).toBeEnabled({
      timeout: MINUTE,
    });
    await newest.getByRole('button', { name: /^Roll back / }).click();

    const confirm = p.getByRole('dialog', { name: 'Roll back this deploy?' });
    await confirm.getByRole('button', { name: 'Roll back', exact: true }).click();
    await expect(confirm).toBeHidden();

    // Back to what the Workspace header deployed just before.
    await expect.poll(() => siteFile(wp(), SITE_SETUP), { timeout: RUN_TIMEOUT }).toBe(SETUP_V4);
    await expect(newest).toContainText('Rolled back', { timeout: MINUTE });
  });
});
