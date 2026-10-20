import { chmodSync, existsSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { delimiter, join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * The "+" menu lets a Claude Code row open a list of models, and a model open a list of efforts.
 * These drive the real app (real pointer, real layout) and check what the fake `claude` was
 * really started with.
 */

let launched: LaunchedApp | undefined;
let savedPath: { key: string; value: string | undefined } | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  if (savedPath) process.env[savedPath.key] = savedPath.value;
  savedPath = undefined;
});

/**
 * Fake CLIs that only record how they were started, put first on PATH for the next launch so the
 * app's detection sees them as installed. The log of each is `<dir>/<name>.log`.
 */
function installFakeClis(names: string[]): string {
  const dir = mkdtempSync(join(tmpdir(), 'agentmate-fakeclis-'));
  for (const name of names) {
    const log = join(dir, `${name}.log`);
    if (process.platform === 'win32') {
      writeFileSync(
        join(dir, `${name}.cmd`),
        [
          '@echo off',
          'if "%~1"=="--version" goto version',
          `>>"${log}" echo(%*`,
          'exit /b 0',
          ':version',
          'echo 1.0.0',
          '',
        ].join('\r\n'),
      );
    } else {
      const script = join(dir, name);
      writeFileSync(
        script,
        [
          '#!/bin/sh',
          'if [ "$1" = "--version" ]; then echo 1.0.0; exit 0; fi',
          `echo "$*" >> '${log}'`,
          '',
        ].join('\n'),
      );
      chmodSync(script, 0o755);
    }
  }
  const key = Object.keys(process.env).find((k) => k.toLowerCase() === 'path') ?? 'PATH';
  savedPath = { key, value: process.env[key] };
  process.env[key] = `${dir}${delimiter}${process.env[key] ?? ''}`;
  return dir;
}

function launchesOf(dir: string, name: string): string[] {
  const log = join(dir, `${name}.log`);
  return existsSync(log)
    ? readFileSync(log, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
    : [];
}

const CLAUDE_ROW = /Claude Code/;

async function openClaudeFlyout(page: Page): Promise<void> {
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'New tab' }).first().click();
  await page.getByRole('menuitem', { name: CLAUDE_ROW }).first().hover();
}

/**
 * Runs `pick` against the open menu until a terminal is really there (right after the reload the
 * workspace is still restoring its layout, which can drop a tab opened that early), then returns
 * the arguments the fake `claude` got.
 */
async function startFromMenu(
  current: LaunchedApp,
  pick: (page: Page) => Promise<void>,
): Promise<string> {
  await openWorkspace(current);
  const { page } = current;
  await expect(page.getByRole('button', { name: 'New tab' }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(async () => {
    if ((await page.locator('.xterm').count()) === 0) {
      await openClaudeFlyout(page);
      await pick(page);
    }
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
  await expect.poll(() => current.claudeLaunches().length, { timeout: 60_000 }).toBeGreaterThan(0);
  return current.claudeLaunches().at(-1) ?? '';
}

test('a model picked in the flyout is what Claude Code starts on', async () => {
  launched = await launchApp({ settings: { defaultCliId: 'claude-code', cliLaunchDefaults: {} } });
  const args = await startFromMenu(launched, async (page) => {
    await page.getByRole('menuitem', { name: /^Opus 5\.5/ }).click();
  });
  expect(args).toContain('--model opus');
  expect(args).not.toContain('--effort');
});

test('a model and effort picked in the two flyouts both reach the CLI', async () => {
  launched = await launchApp({ settings: { defaultCliId: 'claude-code', cliLaunchDefaults: {} } });
  const args = await startFromMenu(launched, async (page) => {
    await page.getByRole('menuitem', { name: /^Sonnet 5\.5/ }).hover();
    await page.getByRole('menuitem', { name: 'High', exact: true }).click();
  });
  expect(args).toContain('--model sonnet --effort high');
});

test('a pick keeps the rest of the launch defaults', async () => {
  launched = await launchApp({
    settings: {
      defaultCliId: 'claude-code',
      cliLaunchDefaults: { 'claude-code': { model: 'haiku', mode: 'plan' } },
    },
  });
  const args = await startFromMenu(launched, async (page) => {
    await page.getByRole('menuitem', { name: /^Opus 5\.5/ }).click();
  });
  expect(args).toContain('--permission-mode plan');
  expect(args).toContain('--model opus');
  expect(args).not.toContain('haiku');
});

test('the first row of the flyout starts Claude Code with the launch defaults', async () => {
  launched = await launchApp({
    settings: {
      defaultCliId: 'claude-code',
      cliLaunchDefaults: { 'claude-code': { model: 'opus', effort: 'high' } },
    },
  });
  const args = await startFromMenu(launched, async (page) => {
    const bare = page.getByRole('menuitem', { name: /Launch with defaults/ });
    // It says what it will start, and the saved model carries the check.
    await expect(bare).toContainText('Opus 5.5 · High');
    await expect(page.locator('[data-saved="true"]')).toHaveCount(1);
    await bare.click();
  });
  expect(args).toContain('--model opus --effort high');
});

test('clicking the agent row itself still starts it with the launch defaults', async () => {
  launched = await launchApp({
    settings: {
      defaultCliId: 'claude-code',
      cliLaunchDefaults: { 'claude-code': { mode: 'auto' } },
    },
  });
  const args = await startFromMenu(launched, async (page) => {
    await page.getByRole('menuitem', { name: CLAUDE_ROW }).first().click();
  });
  expect(args).toContain('--permission-mode auto');
  expect(args).not.toContain('--model');
});

test('Alt+click on a model keeps the model and drops the launch defaults', async () => {
  launched = await launchApp({
    settings: {
      defaultCliId: 'claude-code',
      cliLaunchDefaults: { 'claude-code': { mode: 'plan' } },
    },
  });
  const args = await startFromMenu(launched, async (page) => {
    await page.getByRole('menuitem', { name: /^Opus 5\.5/ }).click({ modifiers: ['Alt'] });
  });
  expect(args).toContain('--model opus');
  expect(args).not.toContain('--permission-mode');
});

/** Opens the menu, hovers an agent row and runs `pick`, until a terminal is really there. */
async function startOtherCli(
  current: LaunchedApp,
  row: RegExp,
  pick: (page: Page) => Promise<void>,
): Promise<void> {
  await openWorkspace(current);
  const { page } = current;
  await expect(page.getByRole('button', { name: 'New tab' }).first()).toBeVisible({
    timeout: 60_000,
  });
  await expect(async () => {
    if ((await page.locator('.xterm').count()) === 0) {
      await page.keyboard.press('Escape');
      await page.getByRole('button', { name: 'New tab' }).first().click();
      await page.getByRole('menuitem', { name: row }).first().hover();
      await pick(page);
    }
    await expect(page.locator('.xterm').first()).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 60_000 });
}

test('Grok starts on a model and one of its effort levels, and stops at High', async () => {
  const fakes = installFakeClis(['grok']);
  launched = await launchApp({ settings: { cliLaunchDefaults: {} } });
  await startOtherCli(launched, /Grok CLI/, async (page) => {
    await page.getByRole('menuitem', { name: /^Grok 4\.7/ }).hover();
    await expect(page.getByRole('menuitem', { name: 'Max', exact: true })).toHaveCount(0);
    await page.getByRole('menuitem', { name: 'Low', exact: true }).click();
  });
  await expect
    .poll(() => launchesOf(fakes, 'grok').at(-1) ?? '', { timeout: 60_000 })
    .toContain('--model grok-4.7 --reasoning-effort low');
});

test('Gemini starts on a picked model and has no effort step', async () => {
  const fakes = installFakeClis(['gemini']);
  launched = await launchApp({ settings: { cliLaunchDefaults: {} } });
  await startOtherCli(launched, /Gemini CLI/, async (page) => {
    const model = page.getByRole('menuitem', { name: /^Gemini 3\.8 Flash/ });
    await expect(model).toContainText('Balanced');
    await expect(model).not.toHaveAttribute('aria-haspopup', 'menu');
    await model.click();
  });
  await expect
    .poll(() => launchesOf(fakes, 'gemini').at(-1) ?? '', { timeout: 60_000 })
    .toContain('--model gemini-3.8-flash');
});

test('Cursor starts on a picked model and has no effort step', async () => {
  const fakes = installFakeClis(['cursor-agent']);
  launched = await launchApp({ settings: { cliLaunchDefaults: {} } });
  await startOtherCli(launched, /Cursor CLI/, async (page) => {
    const model = page.getByRole('menuitem', { name: /^Sonnet 4\.5/ });
    await expect(model).not.toHaveAttribute('aria-haspopup', 'menu');
    await model.click();
  });
  await expect
    .poll(() => launchesOf(fakes, 'cursor-agent').at(-1) ?? '', { timeout: 60_000 })
    .toContain('--model sonnet-4.5');
});
