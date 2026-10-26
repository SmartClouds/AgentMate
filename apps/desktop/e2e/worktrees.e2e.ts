import { execSync } from 'node:child_process';
import { existsSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { initGitRepo, type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * Git worktrees end to end, the way someone uses them: a worktree made from the New worktree
 * dialog opens as a workspace of its own, a commit made there shows up on its Finish card, it
 * merges back into the main checkout, and removing it takes the folder and the merged branch
 * away. A worktree whose folder was deleted by hand is flagged and can be cleaned up.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

function git(cwd: string, args: string): string {
  return execSync(`git -c user.name=e2e -c user.email=e2e@example.com ${args}`, {
    cwd,
    encoding: 'utf8',
  }).trim();
}

/** The project's worktrees as main reports them. */
async function listWorktrees(
  page: Page,
  projectId: string,
): Promise<{ id: string; path: string }[]> {
  return page.evaluate(
    (id) =>
      (
        window as unknown as {
          runova: { worktrees: { list(id: string): Promise<{ id: string; path: string }[]> } };
        }
      ).runova.worktrees.list(id),
    projectId,
  );
}

test('a worktree goes from New worktree to merged and removed', async () => {
  launched = await launchApp({});
  const { page, projectDir } = launched;
  initGitRepo(launched);
  // The helper leaves a change behind; a clean main checkout is what a merge needs.
  git(projectDir, 'add -A');
  git(projectDir, 'commit -q -m "feat: base"');
  const base = git(projectDir, 'branch --show-current');
  const projectId = await openWorkspace(launched);

  // New worktree, from the keyboard.
  await page.getByRole('button', { name: 'Open e2e project' }).waitFor();
  await page.keyboard.press('Control+Shift+N');
  const dialog = page.getByRole('dialog', { name: 'New worktree' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Branch name', exact: true }).fill('feat/e2e');
  const expectedPath = join(`${projectDir}.worktrees`, 'feat-e2e');
  await expect(dialog.getByText(expectedPath)).toBeVisible();
  await dialog.getByRole('textbox', { name: 'Setup command', exact: true }).fill('');
  await dialog.getByRole('radio', { name: 'No agent' }).click();
  await dialog.getByRole('button', { name: /Create worktree/ }).click();
  await expect(dialog).toBeHidden();

  // It opens as a workspace of its own, under its project in the rail.
  const [worktree] = await listWorktrees(page, projectId);
  expect(worktree).toBeTruthy();
  const scopeId = `${projectId}~${worktree?.id}`;
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/workspace/${scopeId}`);
  await expect(page.getByRole('button', { name: 'Open worktree feat/e2e' })).toHaveAttribute(
    'aria-current',
    'page',
  );
  await expect(page.getByRole('button', { name: 'Switch workspace: feat/e2e' })).toBeVisible();
  expect(existsSync(join(expectedPath, 'package.json'))).toBe(true);

  // A commit in the worktree shows on its Finish card.
  writeFileSync(join(expectedPath, 'from-worktree.txt'), 'made in the worktree\n');
  git(expectedPath, 'add -A');
  git(expectedPath, 'commit -q -m "feat: worktree change"');
  const card = page.getByText(`1 commit ahead of ${base}`);
  await expect(async () => {
    // Coming back to the window refreshes git state, the same as it does for a person.
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(card).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });

  // Merge it back.
  await page.getByRole('button', { name: `Merge into ${base}` }).click();
  await page.getByRole('button', { name: 'Merge', exact: true }).click();
  await expect(page.getByText(`Merged feat/e2e into ${base}`)).toBeVisible();
  expect(existsSync(join(projectDir, 'from-worktree.txt'))).toBe(true);

  // Remove it, branch and all, and land back in the main checkout.
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(page.getByText(`Everything here is in ${base}`)).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Remove worktree' }).first().click();
  const remove = page.getByRole('dialog', { name: /Remove the feat\/e2e worktree/ });
  await expect(remove.getByText('Nothing is lost: the branch is merged and clean.')).toBeVisible();
  await expect(remove.getByRole('checkbox', { name: 'Also delete branch feat/e2e' })).toBeChecked();
  await remove.getByRole('button', { name: 'Remove worktree' }).click();
  await expect(remove).toBeHidden();
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/workspace/${projectId}`);
  await expect(page.getByRole('button', { name: 'Open worktree feat/e2e' })).toBeHidden();
  await expect.poll(() => existsSync(expectedPath)).toBe(false);
  expect(git(projectDir, 'branch --list feat/e2e')).toBe('');
});

test('a worktree whose folder was deleted by hand is flagged and cleaned up', async () => {
  launched = await launchApp({});
  const { page, projectDir } = launched;
  initGitRepo(launched);
  const projectId = await openWorkspace(launched);
  await page.getByRole('button', { name: 'Open e2e project' }).waitFor();

  const path = join(`${projectDir}.worktrees`, 'gone');
  git(projectDir, `worktree add -q -b gone "${path}"`);
  rmSync(path, { recursive: true, force: true });

  // The rail picks it up from git and marks it.
  await expect(async () => {
    await page.evaluate(() => window.dispatchEvent(new Event('focus')));
    await expect(
      page.getByRole('button', { name: 'Open worktree gone (folder missing)' }),
    ).toBeVisible({ timeout: 2000 });
  }).toPass({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Open worktree gone (folder missing)' }).click({
    button: 'right',
  });
  await page.getByRole('menuitem', { name: /Remove worktree/ }).click();
  const remove = page.getByRole('dialog', { name: /Remove the gone worktree/ });
  await expect(
    remove.getByText('Its folder is already gone, so this only tidies up git.'),
  ).toBeVisible();
  await remove.getByRole('button', { name: 'Remove worktree' }).click();
  await expect(remove).toBeHidden();
  await expect(page.getByRole('button', { name: /Open worktree gone/ })).toBeHidden();
  expect(await listWorktrees(page, projectId)).toEqual([]);
});
