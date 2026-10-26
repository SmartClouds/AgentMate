import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Studio's motion graphics (E33) in the built app, with a scripted Claude Code
 * (fixtures/fakeStudioClaude.cjs) and the real offscreen checks: every style's reference scene
 * passes, a scene written by the CLI previews in its sandbox in Persian and Vazirmatn, a scene that
 * reaches for the network is caught and repaired, and a hand edit is a new version while the old
 * one still plays.
 */

const FAKE_CLAUDE = join(__dirname, 'fixtures', 'fakeStudioClaude.cjs');
const STYLES = [
  'line-boil',
  'isometric',
  'flat-vector',
  'line-art',
  'soft-3d',
  'shape-morph',
  'sticker-explainer',
  'hud',
  'collage',
  'aurora-glass',
  'bauhaus',
  'synthwave-vhs',
  'pixel-art',
  'liquid',
  'variety-captions',
];

const opened: LaunchedApp[] = [];

test.afterEach(async () => {
  await Promise.all(opened.splice(0).map((launched) => launched.close()));
});

type Bridge = {
  runova: {
    studio: { updateSettings(p: unknown): Promise<unknown> };
    studioScenes: {
      checkStyle(input: unknown): Promise<{ ok: boolean; problems: string[] }>;
    };
  };
};

async function launch(): Promise<LaunchedApp> {
  const launched = await launchApp({ claudeScript: FAKE_CLAUDE });
  opened.push(launched);
  await launched.page.evaluate(
    async (defaultRoot) => {
      await (window as unknown as Bridge).runova.studio.updateSettings({ defaultRoot });
    },
    join(launched.root, 'Videos', 'Runova Studio'),
  );
  return launched;
}

async function videoWithScenario(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Studio', exact: true }).click();
  await page.getByRole('button', { name: 'New video' }).first().click();
  const dialog = page.getByRole('dialog', { name: 'New video' });
  await dialog.getByLabel('What is the video about?').fill('یک ویدیوی کوتاه درباره‌ی آب');
  await dialog.getByRole('radio', { name: '15 s' }).click();
  await dialog.getByRole('button', { name: 'Create and write' }).click();
  await expect(
    page.getByRole('region', { name: 'Scene 1' }).getByLabel('Scene 1 title'),
  ).toHaveValue('قطره', { timeout: 60_000 });
}

test('every style reference scene passes its check in the offscreen window', async () => {
  const { page } = await launch();
  const results = await page.evaluate(async (styles) => {
    const scenes = (window as unknown as Bridge).runova.studioScenes;
    const out: { id: string; ok: boolean; problems: string[] }[] = [];
    for (const styleId of styles) {
      const result = await scenes.checkStyle({ styleId, aspect: '16:9', language: 'fa' });
      out.push({ id: styleId, ...result });
    }
    return out;
  }, STYLES);
  expect(results.filter((r) => !r.ok)).toEqual([]);
});

test('animates a scene with AI, previews it in its sandbox, repairs a scene that reached out, and keeps every version', async () => {
  const { page } = await launch();
  await videoWithScenario(page);
  const scene1 = page.getByRole('region', { name: 'Scene 1' });

  // AC2: the CLI's scene is checked, gets a thumbnail and plays in the preview.
  await scene1.getByRole('button', { name: 'Animate scene 1 with AI' }).click();
  await expect(scene1.getByRole('img', { name: 'Scene 1 animation' })).toBeVisible({
    timeout: 60_000,
  });
  await scene1.getByRole('button', { name: 'Preview' }).click();
  const preview = page.frameLocator('iframe[title="Scene 1 preview"]');
  await expect(preview.locator('#t')).toHaveText('قطره');

  // AC5: Persian, right to left, in Vazirmatn, inside the sandboxed page.
  const text = preview.locator('#t');
  await expect(text).toHaveAttribute('dir', 'rtl');
  expect(await text.evaluate((el) => getComputedStyle(el).fontFamily)).toContain('Vazirmatn');
  expect(await text.evaluate(() => document.fonts.check('120px Vazirmatn'))).toBe(true);

  // AC3: a scene that fetches is caught by the check and sent back; the fixed one is used.
  await scene1.getByRole('button', { name: /Change/ }).click();
  await scene1.getByLabel("What to change in scene 1's animation").fill('NETWORK please');
  await scene1.getByRole('button', { name: 'Ask', exact: true }).click();
  const history = page.getByRole('complementary', { name: 'History' });
  await history.getByRole('tab', { name: 'AI runs' }).click();
  const runs = history.getByRole('list', { name: 'AI runs' });
  await expect(runs.getByRole('listitem').first().getByText('Written')).toBeVisible({
    timeout: 60_000,
  });
  await runs
    .getByRole('listitem')
    .first()
    .getByRole('button', { name: /Details/ })
    .click();
  const details = page.getByRole('dialog', { name: 'AI run' });
  await expect(details.getByText(/Blocked connect-src: https:\/\/example\.com/)).toBeVisible();
  await expect(details.getByRole('region', { name: 'Repair round 1' })).toBeVisible();
  await page.keyboard.press('Escape');

  // AC4: a hand edit is a new version, and an earlier version is still there to go back to.
  await scene1.getByRole('button', { name: /Code/ }).click();
  const code = page.getByRole('dialog', { name: 'Scene 1 code' });
  const editor = code.locator('.monaco-editor').first();
  await expect(editor).toBeVisible();
  await editor.click();
  await page.keyboard.press('Control+End');
  await page.keyboard.type('<!-- edited by hand -->');
  await code.getByRole('button', { name: /Save/ }).click();
  const versions = code.getByRole('complementary', { name: 'Versions' });
  await expect(versions.getByText('Edited the code of scene 1')).toBeVisible();
  await expect(versions.getByRole('listitem')).toHaveCount(3);
  await versions.getByRole('button', { name: 'Use this version' }).last().click();
  await expect(versions.getByText(/Went back to an earlier version/)).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(preview.locator('#t')).toHaveText('قطره');
});
