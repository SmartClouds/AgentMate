import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * The right-click Token usage menu on the workspace's Agent sessions list, in the real app: the
 * history listing finds the Claude Code transcripts, main reads them over IPC, and the menu shows
 * the totals, the split and the models.
 *
 * Claude Code is pointed at a temp config dir through CLAUDE_CONFIG_DIR, and two conversations
 * are written there for the project folder. Dollar amounts come from the catalog's prices, which
 * change, so the cost is checked for its shape and not its value.
 */

let launched: LaunchedApp | undefined;
let configDir = '';

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  rmSync(configDir, { recursive: true, force: true });
});

interface Message {
  id: string;
  model: string;
  usage: Record<string, number>;
}

const SINGLE_ID = '0a1b2c3d-0000-4000-8000-0000000000aa';
const MIXED_ID = '0a1b2c3d-0000-4000-8000-0000000000bb';
const AT = '2026-10-12T10:00:00.000Z';

function transcript(projectDir: string, id: string, prompt: string, messages: Message[]): string {
  const record = (fields: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: AT, cwd: projectDir, sessionId: id, ...fields });
  return `${[
    record({ type: 'user', gitBranch: 'main', message: { role: 'user', content: prompt } }),
    ...messages.map((message) => record({ type: 'assistant', message })),
  ].join('\n')}\n`;
}

/**
 * One run on a single model, with a message logged twice (one line per content block) and a
 * subagent transcript, and one run that moved across three models, one of them unpriced.
 */
function seedConversations(projectDir: string): void {
  const dir = join(configDir, 'projects', projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
  const opus: Message = {
    id: 'msg_1',
    model: 'claude-opus-5-5',
    usage: {
      input_tokens: 1200,
      output_tokens: 3400,
      cache_read_input_tokens: 2_500_000,
      cache_creation_input_tokens: 80_000,
    },
  };
  mkdirSync(join(dir, SINGLE_ID, 'subagents'), { recursive: true });
  writeFileSync(
    join(dir, `${SINGLE_ID}.jsonl`),
    transcript(projectDir, SINGLE_ID, 'Single model run', [opus, opus]),
  );
  writeFileSync(
    join(dir, SINGLE_ID, 'subagents', 'agent-1.jsonl'),
    transcript(projectDir, SINGLE_ID, 'Subagent', [
      { id: 'msg_2', model: 'claude-opus-5-5', usage: { input_tokens: 100, output_tokens: 200 } },
    ]),
  );

  writeFileSync(
    join(dir, `${MIXED_ID}.jsonl`),
    transcript(projectDir, MIXED_ID, 'Mixed models run', [
      {
        id: 'msg_1',
        model: 'claude-opus-5-5',
        usage: {
          input_tokens: 48_000,
          output_tokens: 21_000,
          cache_read_input_tokens: 1_900_000,
          cache_creation_input_tokens: 210_000,
        },
      },
      {
        id: 'msg_2',
        model: 'claude-sonnet-5-5',
        usage: {
          input_tokens: 9_000,
          output_tokens: 6_500,
          cache_read_input_tokens: 400_000,
          cache_creation_input_tokens: 30_000,
        },
      },
      {
        id: 'msg_3',
        model: 'some-custom-model',
        usage: { input_tokens: 5_000, output_tokens: 2_000 },
      },
    ]),
  );
}

async function openUsageMenu(page: Page, title: string): Promise<Locator> {
  await page.getByText(title).click({ button: 'right' });
  const menu = page.getByRole('menu', { name: 'Token usage' });
  await expect(menu).toBeVisible();
  // Past the loading shimmer, which has no numbers.
  await expect(menu.getByText('Cache read')).toBeVisible();
  return menu;
}

/** A legend row or model row: the cell that holds a label, whatever sits beside it. */
const row = (menu: Locator, label: string | RegExp): Locator =>
  menu.getByText(label, { exact: typeof label === 'string' }).locator('..');

test.beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'runova-claude-config-'));
  launched = await launchApp({ env: { CLAUDE_CONFIG_DIR: configDir } });
  seedConversations(launched.projectDir);
  await openWorkspace(launched);
  await launched.page.getByRole('tab', { name: 'Agent sessions' }).click();
});

test('a right-click shows the tokens, the split and the cost of one conversation', async () => {
  const { page } = launched as LaunchedApp;
  const menu = await openUsageMenu(page, 'Single model run');

  // The message logged twice counts once, and the subagent's tokens are in the total.
  await expect(row(menu, 'Tokens')).toHaveText(/Tokens\s*2\.58M\s*2,584,900/);
  await expect(row(menu, 'Input')).toHaveText(/Input\s*1\.3K\s*<1%/);
  await expect(row(menu, 'Output')).toHaveText(/Output\s*3\.6K\s*<1%/);
  await expect(row(menu, 'Cache read')).toHaveText(/Cache read\s*2\.50M\s*97%/);
  await expect(row(menu, 'Cache write')).toHaveText(/Cache write\s*80\.0K\s*3%/);

  // A priced model gives a plain dollar figure: no plus, no unpriced notes, no model list.
  await expect(row(menu, 'Est. cost')).toHaveText(
    /Est\. cost\s*\$\d+\.\d{2}\s*list price estimate/,
  );
  await expect(menu.getByText('Models', { exact: true })).toHaveCount(0);
  await expect(menu.getByText(/No price is known|no known price/)).toHaveCount(0);
  await expect(menu.getByRole('img', { name: /Token split: Input <1%/ })).toBeVisible();
});

test('a conversation across several models lists them and marks the cost as a minimum', async () => {
  const { page } = launched as LaunchedApp;
  const menu = await openUsageMenu(page, 'Mixed models run');

  await expect(row(menu, 'Tokens')).toHaveText(/Tokens\s*2\.63M\s*2,631,500/);
  await expect(row(menu, 'Input')).toHaveText(/Input\s*62\.0K\s*2%/);
  await expect(row(menu, 'Cache read')).toHaveText(/Cache read\s*2\.30M\s*87%/);

  // Busiest model first, each with its own tokens, and the one without a price says so.
  await expect(menu.getByText('Models', { exact: true })).toBeVisible();
  await expect(row(menu, /Opus/)).toHaveText(/Opus.*2\.18M\s*\$\d+\.\d{2}/);
  await expect(row(menu, /Sonnet/)).toHaveText(/Sonnet.*445\.5K\s*\$\d+\.\d{2}/);
  await expect(row(menu, /Custom/)).toHaveText(/Custom.*7\.0K\s*Unpriced/);

  // The priced part is a floor on the cost, shown with a plus and explained underneath.
  await expect(row(menu, 'Est. cost')).toHaveText(/Est\. cost\s*\$\d+\.\d{2}\+/);
  await expect(menu.getByText(/Some models have no known price/)).toBeVisible();
});

test('each conversation has its own numbers, and Escape closes the menu', async () => {
  const { page } = launched as LaunchedApp;

  const first = await openUsageMenu(page, 'Single model run');
  await expect(row(first, 'Tokens')).toHaveText(/2\.58M/);
  await page.keyboard.press('Escape');
  await expect(first).toBeHidden();

  const second = await openUsageMenu(page, 'Mixed models run');
  await expect(row(second, 'Tokens')).toHaveText(/2\.63M/);
  await expect(second.getByText('2.58M')).toHaveCount(0);
  await page.keyboard.press('Escape');
  await expect(second).toBeHidden();
});
