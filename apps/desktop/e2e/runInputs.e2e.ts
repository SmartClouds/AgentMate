import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Run commands that ask for a value, through the real UI. The first test fills the Run form and
 * checks that the filled-in command reaches the terminal: the fake `claude` logs the arguments it
 * starts with, so that log is what shows the command really ran. The second adds a placeholder
 * from the project form and checks what was written to `data/projects.json`.
 */

const NAME = 'Placeholder e2e';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Creates the project over IPC with the given run commands. Returns its id. */
async function createProjectWith(current: LaunchedApp, runCommands: unknown[]): Promise<string> {
  return current.page.evaluate(
    async ({ folderPath, name, commands }) => {
      const api = (
        window as unknown as {
          runova: { projects: { create(input: unknown): Promise<{ id: string }> } };
        }
      ).runova;
      const project = await api.projects.create({
        name,
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: commands,
      });
      return project.id;
    },
    { folderPath: current.projectDir, name: NAME, commands: runCommands },
  );
}

/** A project made over IPC is not in the cached list yet, so the page is reloaded onto it. */
async function openRoute(current: LaunchedApp, hash: string): Promise<void> {
  await current.page.evaluate((target) => {
    location.hash = target;
  }, hash);
  await current.page.reload();
}

function savedRunCommands(current: LaunchedApp, id: string): unknown[] {
  const file = join(current.userDataDir, 'data', 'projects.json');
  if (!existsSync(file)) return [];
  const projects = JSON.parse(readFileSync(file, 'utf-8')) as {
    id: string;
    runCommands: unknown[];
  }[];
  return projects.find((project) => project.id === id)?.runCommands ?? [];
}

test('a run command with a placeholder asks for its value, then runs the filled-in command', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;
  const id = await createProjectWith(current, [
    { id: 'serve', label: 'serve', command: 'claude --serve {{port=3000}}' },
  ]);
  await openRoute(current, `#/workspace/${id}`);

  await page.getByRole('button', { name: `Run ${NAME} (claude --serve <port>)` }).click();

  const form = page.getByRole('dialog', { name: 'Run serve' });
  const port = form.getByRole('textbox', { name: 'Port' });
  await expect(port).toHaveValue('3000');
  await port.fill('4000');
  await expect(form.getByRole('group', { name: 'What will run' })).toContainText(
    'claude --serve 4000',
  );

  await port.press('Enter');

  await expect.poll(() => current.claudeLaunches()).toContain('--serve 4000');
  await expect(page.getByRole('dialog', { name: 'Run serve' })).toHaveCount(0);
});

test('a placeholder added from the project form is saved exactly as written', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;
  const id = await createProjectWith(current, [
    { id: 'dev', label: 'dev', command: 'claude --dev' },
  ]);
  // Loads the project first, then moves within the page to its run commands, the way the
  // Workspace menu's Edit run commands does. A reload straight onto ?edit=run can lose the dialog.
  await openRoute(current, `#/projects/${id}`);
  await expect(page.getByRole('heading', { name: NAME })).toBeVisible();
  await page.evaluate((hash) => {
    location.hash = hash;
  }, `#/projects/${id}?edit=run`);

  const form = page.getByRole('dialog', { name: 'Edit project' });
  await expect(form).toBeVisible();
  await form.getByRole('button', { name: 'Add command that asks for input' }).click();

  // Exact, since "Command 2" is also a substring of the row's Ask and Remove button names.
  const added = form.getByLabel('Command 2', { exact: true });
  await expect(added).toBeFocused();
  await page.keyboard.type('claude --serve ');
  await expect(added).toHaveValue('claude --serve {{value}}');

  await form.getByRole('button', { name: 'Save changes' }).click();

  await expect
    .poll(() => savedRunCommands(current, id))
    .toEqual([
      { id: 'dev', label: 'dev', command: 'claude --dev' },
      { id: expect.any(String), label: '', command: 'claude --serve {{value}}' },
    ]);
});
