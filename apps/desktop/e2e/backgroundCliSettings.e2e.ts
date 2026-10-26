import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProject, initGitRepo, type LaunchedApp, launchApp } from './app';

/**
 * Every Runova feature that asks an AI CLI something in the background must start that CLI
 * with the Arguments box the user saved for it in AI CLI Manager, and nothing from Launch defaults
 * (those are for terminals only).
 * Each test calls the feature the way its screen does and checks the arguments the fake `claude`
 * was really started with.
 */

const USER_SETTINGS = {
  defaultCliId: 'claude-code',
  cliArgs: { 'claude-code': '--verbose --model sonnet' },
  // Launch defaults belong to terminals; none of these may show up in a background run.
  cliLaunchDefaults: { 'claude-code': { model: 'opus', effort: 'high', mode: 'plan' } },
};

type Api = Record<string, Record<string, (...args: unknown[]) => Promise<unknown>>>;

let launched: LaunchedApp;
let projectId: string;

test.describe.configure({ mode: 'serial' });

test.beforeAll(async () => {
  launched = await launchApp({ settings: USER_SETTINGS });
  initGitRepo(launched);
  projectId = await createProject(launched);
});

test.afterAll(async () => {
  await launched?.close();
});

/** Calls `window.runova[area][method](...args)` and returns the CLI arguments it started. */
async function cliArgsFor(area: string, method: string, ...args: unknown[]): Promise<string> {
  const before = launched.claudeLaunches().length;
  const result = await launched.page.evaluate(
    ({ area, method, args }) =>
      (window as unknown as { runova: Api }).runova[area]![method]!(...args),
    { area, method, args },
  );
  await expect
    .poll(() => launched.claudeLaunches().length, {
      message: `${area}.${method} never started claude: ${JSON.stringify(result)}`,
      timeout: 60_000,
    })
    .toBeGreaterThan(before);
  return launched.claudeLaunches().at(-1) ?? '';
}

function expectUserSettings(args: string): void {
  expect(args).toMatch(/^-p\b/);
  expect(args).toContain('--verbose');
  expect(args).toContain('--model sonnet');
  expect(args).not.toContain('opus');
  expect(args).not.toContain('--effort');
  expect(args).not.toContain('plan');
}

test('commit message suggestions use the CLI settings', async () => {
  const args = await cliArgsFor('git', 'suggestCommitMessage', projectId, undefined, 'all');
  expectUserSettings(args);
  expect(args).not.toContain('--permission-mode');
});

test('branch name suggestions use the CLI settings', async () => {
  expectUserSettings(await cliArgsFor('git', 'suggestBranchName', projectId));
});

test('tag suggestions use the CLI settings', async () => {
  expectUserSettings(await cliArgsFor('git', 'suggestTag', projectId));
});

test('version bumps use the CLI settings plus their own write permission', async () => {
  const args = await cliArgsFor('git', 'applyVersion', { projectId, tag: 'v1.1.0' });
  expectUserSettings(args);
  expect(args).toContain('--permission-mode acceptEdits');
});

test('run sizing in Prompt Builder uses the CLI settings', async () => {
  expectUserSettings(
    await cliArgsFor('ai', 'assessRun', {
      prompt: 'Rename a variable in one file.',
      targetAI: 'Claude',
    }),
  );
});

test('skill deep reviews use the CLI settings', async () => {
  const skillDir = join(launched.root, 'skill');
  mkdirSync(skillDir, { recursive: true });
  writeFileSync(
    join(skillDir, 'SKILL.md'),
    '---\nname: e2e-skill\ndescription: A harmless skill.\n---\n\nSay hello.\n',
  );
  expectUserSettings(
    await cliArgsFor('skills', 'runAudit', {
      target: { kind: 'folder', path: skillDir },
      deepReview: true,
      cliId: null,
    }),
  );
});

test('a settings change applies to the next background run without a restart', async () => {
  await launched.page.evaluate(() =>
    (
      window as unknown as {
        runova: { settings: { update(patch: unknown): Promise<unknown> } };
      }
    ).runova.settings.update({
      cliArgs: { 'claude-code': '--model haiku' },
    }),
  );
  const args = await cliArgsFor('git', 'suggestCommitMessage', projectId, undefined, 'all');
  expect(args).toBe('-p --model haiku');
});
