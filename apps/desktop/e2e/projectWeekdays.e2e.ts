import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';

/**
 * "Projects by weekday" on the Token Usage page, in the real app. The scan reads Claude Code
 * transcripts from a temp config folder, and HOME is a temp folder too, so the card can only show
 * what this file writes. The figures are the token counts written here.
 */

let launched: LaunchedApp | undefined;
let configDir = '';
let home = '';

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  rmSync(configDir, { recursive: true, force: true });
  rmSync(home, { recursive: true, force: true });
});

/** Local noon, `daysAgo` days before today, so the weekday is the one on the user's calendar. */
function noonDaysAgo(daysAgo: number): Date {
  const now = new Date();
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo, 12, 0, 0, 0);
}

interface Turn {
  id: string;
  model: string;
  input: number;
  output?: number;
}

function transcript(cwd: string, sessionId: string, at: Date, turns: Turn[]): string {
  return turns
    .map((turn) =>
      JSON.stringify({
        type: 'assistant',
        timestamp: at.toISOString(),
        cwd,
        sessionId,
        message: {
          id: turn.id,
          model: turn.model,
          usage: { input_tokens: turn.input, output_tokens: turn.output ?? 0 },
        },
      }),
    )
    .join('\n')
    .concat('\n');
}

/** Claude Code names a project's transcript folder after the folder the session started in. */
const projectDirOf = (folder: string): string => folder.replace(/[^a-zA-Z0-9]/g, '-');

/**
 * Three folders: the registered project (1200 + 2000 tokens, with a worktree of it adding 800), and
 * an unregistered side project (7000 tokens on a model with no price).
 */
function seedTranscripts(projectFolder: string, sideFolder: string): void {
  const projects = join(configDir, 'projects');
  const mainDir = join(projects, projectDirOf(projectFolder));
  mkdirSync(mainDir, { recursive: true });
  writeFileSync(
    join(mainDir, 'session-main.jsonl'),
    transcript(projectFolder, 'session-main', noonDaysAgo(1), [
      { id: 'main-1', model: 'claude-opus-5-5', input: 1000, output: 200 },
    ]) +
      transcript(projectFolder, 'session-main', noonDaysAgo(3), [
        { id: 'main-2', model: 'claude-opus-5-5', input: 2000 },
      ]),
  );

  const worktree = join(projectFolder, '.claude', 'worktrees', 'feat-x');
  const worktreeDir = join(projects, projectDirOf(worktree));
  mkdirSync(worktreeDir, { recursive: true });
  writeFileSync(
    join(worktreeDir, 'session-feat.jsonl'),
    transcript(worktree, 'session-feat', noonDaysAgo(2), [
      { id: 'feat-1', model: 'claude-opus-5-5', input: 800 },
    ]),
  );

  const sideDir = join(projects, projectDirOf(sideFolder));
  mkdirSync(sideDir, { recursive: true });
  writeFileSync(
    join(sideDir, 'session-side.jsonl'),
    transcript(sideFolder, 'session-side', noonDaysAgo(2), [
      { id: 'side-1', model: 'some-custom-model', input: 7000 },
    ]),
  );
}

test('the card splits the scanned usage by project and by weekday', async () => {
  home = mkdtempSync(join(tmpdir(), 'runova-e2e-home-'));
  configDir = mkdtempSync(join(tmpdir(), 'runova-e2e-claude-'));
  launched = await launchApp({
    env: {
      CLAUDE_CONFIG_DIR: configDir,
      HOME: home,
      USERPROFILE: home,
      CODEX_HOME: join(home, '.codex'),
    },
  });
  const { page, projectDir, root } = launched;
  seedTranscripts(projectDir, join(root, 'side-project'));
  await createProject(launched);

  await page.evaluate(() => {
    window.location.hash = '#/usage';
  });
  await expect(page.getByRole('heading', { name: 'Projects by weekday' })).toBeVisible({
    timeout: 30_000,
  });
  // A scan is cached for half a minute, and the app may have looked before the transcripts existed.
  await page.getByRole('button', { name: 'Refresh' }).click();

  const legend = page.getByRole('group', { name: 'Projects' });
  await expect(legend.getByRole('button')).toHaveCount(2);
  await expect(legend.getByRole('button', { name: /e2e project/ })).toBeVisible();
  await expect(legend.getByRole('button', { name: /side-project/ })).toBeVisible();

  const yesterday = noonDaysAgo(1).toLocaleDateString('en-US', { weekday: 'long' });
  const yesterdayColumn = page.getByRole('img', { name: new RegExp(`^${yesterday}`) });
  // Yesterday's weekday holds the 1200 tokens of the main session and nothing else.
  await expect(yesterdayColumn).toHaveAttribute('aria-label', /e2e project 1\.2K/);

  await page.getByRole('button', { name: 'Table' }).click();
  const table = page.getByRole('table');
  await expect(table.getByRole('row', { name: /e2e project/ })).toContainText('4.0K');
  await expect(table.getByRole('row', { name: /side-project/ })).toContainText('7.0K');
  await expect(table.getByRole('row', { name: /All projects/ })).toContainText('11.0K');

  await page.getByRole('button', { name: 'Chart' }).click();
  await page.getByRole('button', { name: 'Cost' }).click();
  await expect(legend.getByRole('button', { name: /e2e project/ })).toContainText('$');
  await expect(legend.getByRole('button', { name: /side-project/ })).toContainText('no price');

  await yesterdayColumn.hover();
  await expect(page.getByText(new RegExp(`Average .* per ${yesterday}`))).toBeVisible();

  await page.getByRole('button', { name: '7 days' }).click();
  await expect(yesterdayColumn).toHaveAttribute('aria-label', new RegExp(`^${yesterday} \\(`));
});
