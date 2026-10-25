import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { closeApp, createProject, type LaunchedApp, launchApp } from './app';

/**
 * Studio (E31) in the built app: a video made from the library, edited, and every acknowledged
 * edit back after the app is killed outright; a project's video folder refused inside the project;
 * and a second copy of AgentMate kept out of a video the first one has open.
 */

const opened: LaunchedApp[] = [];

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

async function launch(seed: Parameters<typeof launchApp>[0] = {}): Promise<LaunchedApp> {
  const launched = await launchApp(seed);
  opened.push(launched);
  return launched;
}

/** Points Studio's library at the test's own folder, so nothing lands in the real Videos folder. */
async function useLibrary(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (defaultRoot) => {
    await (
      window as unknown as {
        agentmat: { studio: { updateSettings(p: unknown): Promise<unknown> } };
      }
    ).agentmat.studio.updateSettings({ defaultRoot });
  }, folder);
}

async function goTo(page: Page, hash: string): Promise<void> {
  await page.evaluate((target) => {
    location.hash = target;
  }, hash);
}

test('makes a video, edits it, and keeps every edit after the app is killed', async () => {
  const first = await launch();
  const library = join(first.root, 'Videos', 'AgentMate Studio');
  await useLibrary(first.page, library);

  await first.page.getByRole('link', { name: 'Studio', exact: true }).click();
  await first.page.getByRole('button', { name: 'New video' }).first().click();
  const dialog = first.page.getByRole('dialog', { name: 'New video' });
  await dialog.getByLabel('Title').fill('Launch film');
  await dialog.getByRole('radio', { name: 'Vertical 9:16' }).click();
  await dialog.getByRole('button', { name: 'Create video' }).click();

  await expect(first.page.getByLabel('Video title')).toHaveValue('Launch film');
  await first.page.getByRole('button', { name: 'Add scene' }).click();
  const scene = first.page.getByRole('region', { name: 'Scene 1' });
  await scene.getByLabel('Scene 1 title').fill('Hook');
  await scene.getByLabel('Narration').click();
  await scene.getByLabel('Narration').fill('سلام، این یک ویدئوی آزمایشی است.');
  await first.page.getByLabel('Video title').click();
  const history = first.page.getByRole('complementary', { name: 'History' });
  await expect(history.getByText('Edited the narration of scene 1')).toBeVisible();

  const standalone = join(library, 'Standalone');
  const [folder] = readdirSync(standalone);
  expect(folder).toMatch(/^Launch-film-[a-z0-9]{8}$/);
  expect(existsSync(join(standalone, folder as string, '.studio.lock'))).toBe(true);

  // No goodbye: the process dies the way a crash or a power cut would end it.
  first.app.process().kill('SIGKILL');
  await closeApp(first.app).catch(() => undefined);
  opened.splice(opened.indexOf(first), 1);

  const second = await launch({ reuseRoot: first.root });
  await goTo(second.page, '#/studio');
  await second.page.getByRole('button', { name: 'Launch film', exact: true }).click();
  const again = second.page.getByRole('region', { name: 'Scene 1' });
  await expect(again.getByLabel('Scene 1 title')).toHaveValue('Hook');
  await expect(again.getByLabel('Narration')).toHaveValue('سلام، این یک ویدئوی آزمایشی است.');

  // Undo still works across the restart, and the crashed run's lock did not keep the video shut.
  await second.page.getByRole('button', { name: 'Undo' }).click();
  await expect(again.getByLabel('Narration')).toHaveValue('');
});

test("refuses a project's video folder inside the project source", async () => {
  const launched = await launch();
  await useLibrary(launched.page, join(launched.root, 'Videos', 'AgentMate Studio'));
  const projectId = await createProject(launched);
  await goTo(launched.page, `#/projects/${projectId}?tab=studio`);
  await launched.page.reload();

  await launched.page.getByRole('button', { name: 'Change folder' }).click();
  const dialog = launched.page.getByRole('dialog', { name: 'Video folder for this project' });
  await dialog.getByLabel('Folder').fill(join(launched.projectDir, 'videos'));
  await expect(dialog.getByText(/inside the project's folder/)).toBeVisible();
  await expect(dialog.getByRole('button', { name: 'Save' })).toBeDisabled();

  await dialog.getByLabel('Folder').fill(join(launched.root, 'Shop videos'));
  await expect(dialog.getByText('Studio can keep videos here.')).toBeVisible();
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(
    launched.page.getByText(join(launched.root, 'Shop videos'), { exact: true }),
  ).toBeVisible();
});

test('keeps a second copy of AgentMate out of a video the first one has open', async () => {
  const first = await launch();
  await useLibrary(first.page, join(first.root, 'Videos', 'AgentMate Studio'));
  const video = await first.page.evaluate(async () => {
    const studio = (
      window as unknown as {
        agentmat: { studio: { create(input: unknown): Promise<{ id: string; folder: string }> } };
      }
    ).agentmat.studio;
    return studio.create({ title: 'Shared film', projectId: null, language: 'en', aspect: '16:9' });
  });
  await goTo(first.page, `#/studio/${video.id}`);
  await expect(first.page.getByLabel('Video title')).toHaveValue('Shared film');

  const second = await launch();
  await second.page.evaluate(async (folder) => {
    await (
      window as unknown as { agentmat: { studio: { addExisting(f: string): Promise<unknown> } } }
    ).agentmat.studio.addExisting(folder);
  }, video.folder);
  await goTo(second.page, `#/studio/${video.id}`);
  await expect(second.page.getByText('Open in another AgentMate')).toBeVisible();
  await expect(second.page.getByRole('button', { name: 'Take over' })).toHaveCount(0);

  // Once the first copy closes the video, the second one can open it.
  await goTo(first.page, '#/studio');
  await expect(first.page.getByRole('button', { name: 'New video' }).first()).toBeVisible();
  await second.page.getByRole('button', { name: 'Try again' }).click();
  await expect(second.page.getByLabel('Video title')).toHaveValue('Shared film');
});
