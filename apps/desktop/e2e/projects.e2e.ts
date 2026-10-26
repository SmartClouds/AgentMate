import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * A project's whole life through the real UI: created from the folder picker, listed, opened,
 * renamed, and removed through the confirmation. Each step is checked against what the app wrote
 * to `data/projects.json` inside the test's own profile, so a screen that looks right while
 * nothing reached disk still fails.
 *
 * The native folder picker is the one thing a test cannot click, so `dialog.showOpenDialog` is
 * stubbed in the main process to answer with the temp project folder.
 */

const NAME = 'Lantern e2e';
const RENAMED = 'Lantern e2e renamed';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

interface StoredProject {
  id: string;
  name: string;
  folderPath: string;
}

function projectsOnDisk(current: LaunchedApp): StoredProject[] {
  const file = join(current.userDataDir, 'data', 'projects.json');
  if (!existsSync(file)) return [];
  return JSON.parse(readFileSync(file, 'utf-8')) as StoredProject[];
}

test('create, open, rename and remove a project', async () => {
  launched = await launchApp({ settings: {} });
  const { page, app, projectDir } = launched;
  const current = launched;

  // The picker answers with the temp folder this run owns.
  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, projectDir);

  await page.getByRole('link', { name: 'Projects' }).click();
  await expect(page.getByText('No projects yet')).toBeVisible();

  await page.getByRole('button', { name: 'New Project' }).first().click();
  const form = page.getByRole('dialog', { name: 'New project' });
  await expect(form).toBeVisible();

  await form.getByRole('button', { name: 'Browse' }).click();
  // Picking a folder fills the path, and names the project after it when the box is empty.
  await expect(form.getByLabel('Folder')).toHaveValue(projectDir);
  await expect(form.getByLabel(/^Name/)).not.toHaveValue('');

  await form.getByLabel(/^Name/).fill(NAME);
  await form.getByLabel('Description').fill('Made by the e2e suite.');
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(form).toBeHidden();

  await expect(page.getByRole('button', { name: NAME })).toBeVisible();
  await expect.poll(() => projectsOnDisk(current).map((p) => p.name)).toEqual([NAME]);
  expect(projectsOnDisk(current)[0].folderPath).toBe(projectDir);
  const projectId = projectsOnDisk(current)[0].id;

  // Opening the card lands on that project's own page.
  await page.getByRole('button', { name: NAME }).click();
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
  await expect
    .poll(() => page.evaluate(() => window.location.hash))
    .toBe(`#/projects/${projectId}`);
  await expect(page.getByText('Made by the e2e suite.')).toBeVisible();

  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: 'Edit project' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit project' });
  await expect(edit.getByLabel(/^Name/)).toHaveValue(NAME);
  await edit.getByLabel(/^Name/).fill(RENAMED);
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(edit).toBeHidden();

  await expect(page.getByRole('heading', { level: 1, name: RENAMED })).toBeVisible();
  await expect.poll(() => projectsOnDisk(current).map((p) => p.name)).toEqual([RENAMED]);
  // The rename kept the same project rather than making a second one.
  expect(projectsOnDisk(current)[0].id).toBe(projectId);

  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove project' }).click();
  const confirm = page.getByRole('dialog', { name: `Remove "${RENAMED}"?` });
  await expect(confirm).toBeVisible();
  await expect(confirm).toContainText('Files on disk are kept.');
  await confirm.getByRole('button', { name: 'Remove' }).click();

  // Removing sends the page back to the list, which is empty again.
  await expect.poll(() => page.evaluate(() => window.location.hash)).toBe('#/projects');
  await expect(page.getByText('No projects yet')).toBeVisible();
  await expect.poll(() => projectsOnDisk(current)).toEqual([]);
  // The folder itself is untouched, which is what the confirmation promised.
  expect(existsSync(projectDir)).toBe(true);
});

test('a removed project is gone after a reload, and cancelling keeps it', async () => {
  launched = await launchApp({ settings: {} });
  const { page, app, projectDir } = launched;
  const current = launched;

  await app.evaluate(({ dialog }, folder) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [folder] });
  }, projectDir);

  await page.getByRole('link', { name: 'Projects' }).click();
  await page.getByRole('button', { name: 'New Project' }).first().click();
  const form = page.getByRole('dialog', { name: 'New project' });
  await form.getByRole('button', { name: 'Browse' }).click();
  await form.getByLabel(/^Name/).fill(NAME);
  await form.getByRole('button', { name: 'Create project' }).click();
  await expect(form).toBeHidden();
  await expect(page.getByRole('button', { name: NAME })).toBeVisible();

  await page.getByRole('button', { name: NAME }).click();
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();

  // Saying no leaves the project exactly where it was.
  await page.getByRole('button', { name: 'More project actions' }).click();
  await page.getByRole('menuitem', { name: 'Remove project' }).click();
  const confirm = page.getByRole('dialog', { name: `Remove "${NAME}"?` });
  await confirm.getByRole('button', { name: 'Cancel' }).click();
  await expect(confirm).toBeHidden();
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
  expect(projectsOnDisk(current).map((p) => p.name)).toEqual([NAME]);

  // It survives a reload, which is the app reading it back off disk rather than from its cache.
  await page.reload();
  await page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  await expect(page.getByRole('heading', { level: 1, name: NAME })).toBeVisible();
});
