import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';

/**
 * The Usage section of a project's page, in the real app: the history listing finds the Claude
 * Code transcripts of the project folder, a worker thread parses them, and the page shows the
 * totals, the chart and the breakdowns.
 *
 * Three conversations are written for the project: a recent one, one from two months ago, and a
 * resumed copy of the recent one that repeats its first message. The repeated message must count
 * once, and the old conversation must drop out of the 7 day view. Dollar amounts come from the
 * catalog's prices, which change, so the cost is checked for its shape and not its value.
 */

let launched: LaunchedApp | undefined;
let configDir = '';

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  rmSync(configDir, { recursive: true, force: true });
});

const DAY_MS = 86_400_000;
const RECENT_ID = '0a1b2c3d-0000-4000-8000-0000000000c1';
const OLD_ID = '0a1b2c3d-0000-4000-8000-0000000000c2';
const RESUMED_ID = '0a1b2c3d-0000-4000-8000-0000000000c3';

interface Message {
  id: string;
  at: Date;
  usage: Record<string, number>;
}

function transcript(projectDir: string, id: string, prompt: string, messages: Message[]): string {
  const record = (at: Date, fields: Record<string, unknown>): string =>
    JSON.stringify({ timestamp: at.toISOString(), cwd: projectDir, sessionId: id, ...fields });
  return `${[
    record(messages[0].at, {
      type: 'user',
      gitBranch: 'main',
      message: { role: 'user', content: prompt },
    }),
    ...messages.map((message) =>
      record(message.at, {
        type: 'assistant',
        message: { id: message.id, model: 'claude-opus-5-5', usage: message.usage },
      }),
    ),
  ].join('\n')}\n`;
}

function seedConversations(projectDir: string): void {
  const dir = join(configDir, 'projects', projectDir.replace(/[^a-zA-Z0-9]/g, '-'));
  mkdirSync(dir, { recursive: true });
  const now = new Date();
  const twoMonthsAgo = new Date(now.getTime() - 60 * DAY_MS);
  // The chart's last bar is today. An hour or two ago is yesterday just after midnight (CI failed
  // at 00:30), so early in the day the recent messages go into the part of today that has passed.
  const startOfToday = new Date(now).setHours(0, 0, 0, 0);
  const hoursAgo = (hours: number): Date =>
    new Date(
      Math.max(
        now.getTime() - hours * 3_600_000,
        startOfToday + ((now.getTime() - startOfToday) * (3 - hours)) / 3,
      ),
    );

  const first: Message = {
    id: 'msg_recent_1',
    at: hoursAgo(2),
    usage: { input_tokens: 1000, output_tokens: 2000, cache_read_input_tokens: 3_000_000 },
  };
  writeFileSync(
    join(dir, `${RECENT_ID}.jsonl`),
    transcript(projectDir, RECENT_ID, 'Recent run', [first]),
  );

  const old: Message = {
    id: 'msg_old_1',
    at: twoMonthsAgo,
    usage: { input_tokens: 500, output_tokens: 500, cache_read_input_tokens: 1_000_000 },
  };
  const oldFile = join(dir, `${OLD_ID}.jsonl`);
  writeFileSync(oldFile, transcript(projectDir, OLD_ID, 'Old run', [old]));
  // A transcript nobody touched for two months, so the 7 day view never has to open it.
  utimesSync(oldFile, twoMonthsAgo, twoMonthsAgo);

  // Resuming a conversation copies what came before into the new file.
  writeFileSync(
    join(dir, `${RESUMED_ID}.jsonl`),
    transcript(projectDir, RESUMED_ID, 'Resumed run', [
      first,
      {
        id: 'msg_resumed_2',
        at: hoursAgo(1),
        usage: { input_tokens: 10, output_tokens: 20 },
      },
    ]),
  );
}

async function openUsage(page: Page, projectId: string): Promise<void> {
  // A project made through IPC is not in the cached list yet, so reload onto its page.
  await page.evaluate((id) => {
    location.hash = `#/projects/${id}?tab=usage`;
  }, projectId);
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Usage and cost' })).toBeVisible();
}

test.beforeEach(async () => {
  configDir = mkdtempSync(join(tmpdir(), 'runova-claude-config-'));
  launched = await launchApp({ env: { CLAUDE_CONFIG_DIR: configDir } });
  seedConversations(launched.projectDir);
  const id = await createProject(launched);
  await openUsage(launched.page, id);
});

test('totals everything the project spent, counting a copied message once', async () => {
  const { page } = launched as LaunchedApp;

  // 3,003,000 recent + 1,001,000 old + 30 new in the resumed copy. The copied message would add
  // another 3,003,000 if it counted twice.
  const tokens = page.getByText('4,004,030');
  await expect(tokens).toBeVisible();
  // The exact count sits under the short figure, in the same tile.
  await expect(tokens.locator('..')).toContainText('4.00M');
  await expect(page.getByText('Conversations', { exact: true })).toBeVisible();
  await expect(page.getByText('across 1 agent')).toBeVisible();

  const cost = page.getByText('Est. cost', { exact: true }).locator('..');
  await expect(cost).toHaveText(/Est\. cost\s*\$\d+\.\d{2}\s*list price estimate/);
  await expect(page.getByText(/Costs are estimated at public list prices/)).toBeVisible();
});

test('breaks the spend down by agent, model and conversation', async () => {
  const { page } = launched as LaunchedApp;
  await expect(page.getByText('4,004,030')).toBeVisible();

  await expect(page.getByRole('list', { name: 'Spend by agent' })).toContainText('Claude');
  await expect(page.getByRole('list', { name: 'Spend by model' })).toContainText('Opus 5.5');
  await expect(page.getByRole('img', { name: /Token split: Input/ })).toBeVisible();

  // The recent conversation has the most tokens on the same model, so it costs the most.
  const top = page
    .getByRole('list', { name: 'Most expensive conversations' })
    .getByRole('listitem');
  await expect(top).toHaveCount(3);
  await expect(top.nth(0)).toContainText('Recent run');
  await expect(top.nth(0)).toContainText(/\$\d+\.\d{2}/);
  await expect(top.nth(1)).toContainText('Old run');
  await expect(top.nth(2)).toContainText('Resumed run');
});

test('the 7 day view leaves out the old conversation and draws a bar per day', async () => {
  const { page } = launched as LaunchedApp;
  await expect(page.getByText('4,004,030')).toBeVisible();

  await page.getByRole('button', { name: '7 days' }).click();

  await expect(page.getByText('3,003,030')).toBeVisible();
  await expect(page.getByText('4,004,030')).toHaveCount(0);
  await expect(page.getByRole('button', { name: '7 days' })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  await expect(page.getByRole('list', { name: 'Spend per day' }).getByRole('listitem')).toHaveCount(
    7,
  );
  const top = page
    .getByRole('list', { name: 'Most expensive conversations' })
    .getByRole('listitem');
  await expect(top).toHaveCount(2);
  await expect(top.filter({ hasText: 'Old run' })).toHaveCount(0);

  // Back to everything, which was kept and so is there at once.
  await page.getByRole('button', { name: 'All time' }).click();
  await expect(page.getByText('4,004,030')).toBeVisible();
});

test('the chart can switch from cost to tokens, and a bar says what it holds', async () => {
  const { page } = launched as LaunchedApp;
  await expect(page.getByText('4,004,030')).toBeVisible();

  const chart = page
    .getByRole('list', { name: 'Spend per day' })
    .or(page.getByRole('list', { name: 'Spend per week' }));
  await expect(chart.getByRole('listitem').last()).toHaveAccessibleName(/\$\d+\.\d{2}, .* tokens$/);

  await page.getByRole('button', { name: 'Tokens', exact: true }).click();
  await expect(page.getByText(/^Tokens over time$/)).toBeVisible();
});
