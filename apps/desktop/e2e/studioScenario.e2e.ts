import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Studio's scenario writer (E32) in the built app, against a scripted Claude Code
 * (fixtures/fakeStudioClaude.cjs): a Persian video made from a brief, with a broken first answer
 * repaired on the way; the run's record showing the CLI, model and prompt; and a change asked for
 * by typing, applied as one step that one Undo takes back.
 */

const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fakeStudioClaude.cjs');

const opened: LaunchedApp[] = [];

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

async function useLibrary(page: Page, folder: string): Promise<void> {
  await page.evaluate(async (defaultRoot) => {
    await (
      window as unknown as {
        runova: { studio: { updateSettings(p: unknown): Promise<unknown> } };
      }
    ).runova.studio.updateSettings({ defaultRoot });
  }, folder);
}

test('writes a Persian scenario from a brief, repairs a bad answer, and edits it by typing', async () => {
  const launched = await launchApp({ claudeScript: FAKE_CLAUDE });
  opened.push(launched);
  const { page, root } = launched;
  await useLibrary(page, join(root, 'Videos', 'Runova Studio'));

  await page.getByRole('link', { name: 'Studio', exact: true }).click();
  await page.getByRole('button', { name: 'New video' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New video' });
  await dialog
    .getByLabel('What is the video about?')
    .fill('BROKEN یک ویدیوی کوتاه درباره‌ی صرفه‌جویی در آب برای خانواده‌ها');
  await dialog.getByRole('radio', { name: '30 s' }).click();
  await dialog.getByRole('combobox', { name: 'CLI' }).click();
  await page
    .getByRole('option', { name: /Claude Code/ })
    .first()
    .click();
  await dialog.getByRole('combobox', { name: 'Model' }).click();
  await page.getByRole('option', { name: /Opus/ }).first().click();
  await dialog.getByRole('button', { name: 'Create and write' }).click();

  // The run starts once the editor has the video, and the broken first answer is sent back.
  const scene1 = page.getByRole('region', { name: 'Scene 1' });
  await expect(scene1.getByLabel('Scene 1 title')).toHaveValue('قطره', { timeout: 60_000 });
  await expect(page.getByLabel('Video title')).toHaveValue('آب، زندگی');
  await expect(page.getByRole('region', { name: 'Scene 3' })).toBeVisible();

  // AC5: the run's record names the CLI and model, and keeps the request and the repair.
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('tab', { name: 'AI runs' }).click();
  const runs = history.getByRole('list', { name: 'AI runs' });
  await expect(runs.getByText('Written')).toBeVisible();
  await runs
    .getByRole('button', { name: /Details/ })
    .first()
    .click();
  const details = page.getByRole('dialog', { name: 'AI run' });
  await expect(details.getByText(/^Claude Code · Opus/)).toBeVisible();
  await expect(details.getByRole('region', { name: 'Repair round 1' })).toBeVisible();
  await details
    .getByRole('region', { name: 'First try' })
    .getByRole('button', { name: /Request sent/ })
    .click();
  await expect(details.getByText(/BROKEN/).first()).toBeVisible();
  await page.keyboard.press('Escape');

  const launches = readFileSync(join(root, 'claude-launches.log'), 'utf8');
  expect(launches).toMatch(/-p .*--model/);

  // Edit by typing: a proposal, applied as one entry, taken back by one Undo.
  await page.getByLabel('What should change').fill('عنوان صحنه‌ی اول را «آغاز» کن');
  await page.getByRole('form', { name: 'Ask AI' }).getByRole('button', { name: /Ask/ }).click();
  const proposal = page.getByRole('region', { name: 'AI proposal' });
  await expect(proposal.getByText('Renamed the first scene.')).toBeVisible({ timeout: 60_000 });
  await proposal.getByRole('button', { name: /Apply/ }).click();
  await expect(scene1.getByLabel('Scene 1 title')).toHaveValue('آغاز');
  await expect(proposal).toBeHidden();

  await page.getByRole('button', { name: 'Undo' }).click();
  await expect(scene1.getByLabel('Scene 1 title')).toHaveValue('قطره');
  await expect(page.getByRole('region', { name: 'Scene 3' })).toBeVisible();
});
