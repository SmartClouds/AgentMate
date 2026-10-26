import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * The agent tab's right-click menu in the real app: Rename (which once closed its own name field,
 * since the closing menu took focus back), the two auto-continue switches, and a continue being
 * scheduled when the agent really prints a network error.
 *
 * The `claude` on PATH is replaced by one that stays running like the real CLI, and prints
 * Claude Code's "API Error: Connection error." when it is sent `go`. The continue itself is sent
 * minutes later, which the main-process tests cover with a fake clock.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** A `claude` that waits for input, and fails the way a dropped connection does on `go`. */
function writeInteractiveClaude(root: string): void {
  const binDir = join(root, 'bin');
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'claude.cmd'),
      [
        '@echo off',
        'if "%~1"=="--version" goto version',
        'echo Fake Claude ready',
        ':loop',
        'set "line="',
        'set /p line=',
        'if "%line%"=="go" echo API Error: Connection error.',
        'goto loop',
        ':version',
        'echo 9.9.9 (Claude Code)',
        '',
      ].join('\r\n'),
    );
    return;
  }
  const script = join(binDir, 'claude');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      'if [ "$1" = "--version" ]; then echo "9.9.9 (Claude Code)"; exit 0; fi',
      'echo "Fake Claude ready"',
      'while read line; do',
      '  if [ "$line" = "go" ]; then echo "API Error: Connection error."; fi',
      'done',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
}

interface OutputApi {
  runova: {
    terminal: {
      write(sessionId: string, data: string): Promise<void>;
      onData(callback: (payload: { sessionId: string; data: string }) => void): () => void;
    };
  };
  __e2eOutput?: Record<string, string>;
}

async function captureOutput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as OutputApi;
    target.__e2eOutput = {};
    target.runova.terminal.onData(({ sessionId, data }) => {
      const store = target.__e2eOutput ?? {};
      store[sessionId] = (store[sessionId] ?? '') + data;
      target.__e2eOutput = store;
    });
  });
}

/** Opens a Claude Code tab from the pane's "+" menu and waits for the fake CLI to start. */
async function openClaudeTab(page: Page): Promise<{ tab: Locator; sessionId: string }> {
  await captureOutput(page);
  await page.getByRole('button', { name: 'New tab' }).first().click();
  await page
    .getByRole('menuitem', { name: /Claude Code/ })
    .first()
    .click();
  const tab = page.getByRole('tab').first();
  await expect(tab).toBeVisible();
  const sessionId = (await tab.getAttribute('data-tab-id')) ?? '';
  await expect
    .poll(() =>
      page.evaluate((id) => (window as unknown as OutputApi).__e2eOutput?.[id] ?? '', sessionId),
    )
    .toContain('Fake Claude ready');
  return { tab, sessionId };
}

test('rename an agent tab and turn auto-continue on from its right-click menu', async () => {
  launched = await launchApp({ settings: {} });
  writeInteractiveClaude(launched.root);
  await openWorkspace(launched);
  const { page } = launched;
  const { tab } = await openClaudeTab(page);

  await tab.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Rename' })).toBeVisible();
  await expect(page.getByRole('menuitem', { name: 'Close' })).toBeVisible();
  const limit = page.getByRole('menuitemcheckbox', { name: 'After the usage limit resets' });
  await expect(limit).toHaveAttribute('aria-checked', 'false');
  await limit.click();
  await expect(limit).toHaveAttribute('aria-checked', 'true');
  await page.keyboard.press('Escape');

  // Rename from the menu: the name field has to still be open and focused once the menu is gone.
  await tab.click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Rename' }).click();
  const name = page.getByRole('textbox', { name: 'Tab name' });
  await expect(name).toBeFocused();
  await page.waitForTimeout(500);
  await expect(name).toBeFocused();
  await name.fill('Backend agent');
  await name.press('Enter');
  await expect(page.getByRole('tab').first()).toContainText('Backend agent');

  // The switch is remembered for the tab.
  await page.getByRole('tab').first().click({ button: 'right' });
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'After the usage limit resets' }),
  ).toHaveAttribute('aria-checked', 'true');
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'After a network error' }),
  ).toHaveAttribute('aria-checked', 'false');
});

test('a network error schedules a continue that can be cancelled', async () => {
  launched = await launchApp({ settings: {} });
  writeInteractiveClaude(launched.root);
  await openWorkspace(launched);
  const { page } = launched;
  const { tab, sessionId } = await openClaudeTab(page);

  await tab.click({ button: 'right' });
  await page.getByRole('menuitemcheckbox', { name: 'After a network error' }).click();
  await page.keyboard.press('Escape');

  // Main learns about the switch through the tab sync, then the CLI fails.
  await expect
    .poll(() =>
      page.evaluate(async (id) => {
        await (window as unknown as OutputApi).runova.terminal.write(id, 'go\r');
        await new Promise((resolve) => setTimeout(resolve, 500));
        const api = window as unknown as {
          runova: { agents: { autoContinuePending(): Promise<Record<string, unknown>> } };
        };
        return Object.keys(await api.runova.agents.autoContinuePending());
      }, sessionId),
    )
    .toContain(sessionId);

  await tab.click({ button: 'right' });
  await expect(page.getByText(/Network error\. Sending "continue" at .*\(try 1\)/)).toBeVisible();
  await page.getByRole('menuitem', { name: 'Cancel scheduled continue' }).click();

  await tab.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: 'Cancel scheduled continue' })).toHaveCount(0);
  // Cancelling drops this one continue; the switch itself stays on.
  await expect(
    page.getByRole('menuitemcheckbox', { name: 'After a network error' }),
  ).toHaveAttribute('aria-checked', 'true');
});
