import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type FakeOllama, startFakeOllama } from './fakeOllama';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  serverExec,
  startSshServer,
} from './sshServer';

/**
 * "Ask AI to run a task here" on a real SSH server (Docker), through the real app. The AI is a
 * fake Ollama following a script. Covers what users reported: marker text showing up in the
 * terminal, and sudo needing a typed password instead of the one saved for the server.
 */

test.skip(!dockerAvailable(), 'needs Docker to start the test SSH server');

let server: SshTestServer | undefined;
let ollama: FakeOllama | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(600_000);
  server = await startSshServer();
});

test.afterAll(() => {
  server?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await ollama?.close();
  ollama = undefined;
});

const SHELL_PROMPT = `${SSH_USER}@e2e-server:~$`;

/** The active terminal tab's visible rows, as text. */
function terminalRows(page: Page): Locator {
  return page.locator('.terminal-pane .xterm-rows');
}

async function terminalText(page: Page): Promise<string> {
  return (await terminalRows(page).innerText()).replace(/ /g, ' ');
}

/** The AI status bar above the terminal. */
function agentBar(page: Page): Locator {
  return page.locator('.terminal-well').locator('xpath=preceding-sibling::div[1]');
}

async function openServerTab(replies: string[]): Promise<Page> {
  if (!server) throw new Error('SSH server did not start');
  ollama = await startFakeOllama(replies);
  launched = await launchApp({
    settings: {
      promptBuilderProvider: 'ollama',
      ollamaModel: 'e2e-script',
      ollamaBaseUrl: ollama.url,
    },
  });
  const { page } = launched;

  // Saved through the app itself, so the password is encrypted the way a real save does it.
  await page.evaluate(
    (input) =>
      (
        window as unknown as { runova: { ssh: { saveServer(i: unknown): Promise<unknown> } } }
      ).runova.ssh.saveServer(input),
    {
      nickname: 'E2E server',
      host: server.host,
      port: server.port,
      username: SSH_USER,
      authMethod: 'password',
      secret: SSH_PASSWORD,
    },
  );

  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await page.getByRole('button', { name: 'SSH', exact: true }).click();
  // The Remote page has a "Connect" tab of its own, so this has to be the server's own button.
  const savedServer = page.getByRole('listitem').filter({ hasText: 'E2E server' });
  await expect(savedServer).toBeVisible({ timeout: 30_000 });
  await savedServer.getByRole('button', { name: 'Connect' }).click();
  await expect(terminalRows(page)).toContainText(SHELL_PROMPT, { timeout: 30_000 });
  // The docked drawer only shows a few rows, so earlier commands would scroll out of view.
  await page.getByRole('button', { name: 'Maximize terminal' }).click();
  return page;
}

async function startTask(page: Page, prompt: string): Promise<void> {
  await page.getByRole('button', { name: 'Ask AI to run a task here' }).click();
  // The CLI picker's popover is a dialog too, so match the task dialog by name.
  const dialog = page.getByRole('dialog', { name: 'Ask AI to run a task here' });
  await dialog.getByRole('textbox', { name: 'Task for the AI' }).fill(prompt);
  const cli = dialog.getByRole('combobox').first();
  await expect(cli).toBeEnabled({ timeout: 30_000 });
  if (!(await cli.innerText()).includes('AI provider (Settings)')) {
    await cli.click();
    await page.getByRole('option', { name: 'AI provider (Settings)' }).click();
  }
  await dialog.getByText('Fully autonomous').click();
  await dialog.getByRole('button', { name: 'Start' }).click();
  await expect(dialog).toBeHidden();
}

test('runs commands with clean output and answers sudo with the saved password', async () => {
  const page = await openServerTab([
    'RUN: grep CODENAME /etc/os-release',
    'RUN: sudo -n id -u',
    'RUN: echo tick1; sleep 3; echo tick2',
    'FINISHED: Checked the server.',
  ]);
  await startTask(page, 'Check the OS and that sudo works');

  // The AI asked for `sudo -n`; it runs as plain sudo so the password bar can answer it.
  const bar = agentBar(page);
  await expect(bar).toContainText('is asking for a password', { timeout: 60_000 });
  await bar.getByRole('button', { name: 'Enter password' }).click();

  // Output shows up while the command is still going.
  await expect(terminalRows(page)).toContainText('tick1', { timeout: 60_000 });
  expect(await terminalText(page)).not.toMatch(/^tick2$/m);
  await expect(bar).toContainText('Running');

  await expect(bar).toContainText('Checked the server.', { timeout: 60_000 });
  // The bar can update before xterm paints the last rows, so wait for them before reading.
  await expect.poll(() => terminalText(page)).toMatch(/^tick1\ntick2$/m);

  const text = await terminalText(page);
  expect(text).toContain(`${SHELL_PROMPT} grep CODENAME /etc/os-release`);
  expect(text).toContain('UBUNTU_CODENAME=jammy');
  expect(text).toContain(`${SHELL_PROMPT} sudo id -u`);
  expect(text).toMatch(/^0$/m);
  expect(text).toContain(`${SHELL_PROMPT} echo tick1; sleep 3; echo tick2`);
  expect(text).toMatch(/^tick1\ntick2$/m);
  expect(text).not.toContain('RUNOVA');
  expect(text).not.toContain('Runova:');
  expect(text).not.toContain('printf');
  expect(text).not.toContain(SSH_PASSWORD);
  expect(text).not.toContain('a password is required');

  // The AI saw real results and never the password.
  const transcript = ollama?.prompts.at(-1) ?? '';
  expect(transcript).toContain('$ sudo id -u [exit code 0]');
  expect(transcript).toContain(
    '$ grep CODENAME /etc/os-release [exit code 0]\nVERSION_CODENAME=jammy\nUBUNTU_CODENAME=jammy',
  );
  expect(ollama?.prompts.join('\n')).not.toContain(SSH_PASSWORD);
});

test('lets the user type the sudo password themselves', async () => {
  const page = await openServerTab(['RUN: sudo id -un', 'FINISHED: Confirmed root.']);
  await startTask(page, 'Check sudo');

  const bar = agentBar(page);
  await expect(bar).toContainText('is asking for a password', { timeout: 60_000 });
  await bar.getByRole('button', { name: "I'll type it" }).click();

  // The xterm screen sits over the rows and takes the pointer events.
  await page.locator('.terminal-pane .xterm-screen').click();
  await page.keyboard.type(SSH_PASSWORD);
  await page.keyboard.press('Enter');

  await expect(bar).toContainText('Confirmed root.', { timeout: 60_000 });
  await expect.poll(() => terminalText(page)).toMatch(/^root$/m);
  const text = await terminalText(page);
  expect(text).toMatch(/^root$/m);
  expect(text).not.toContain(SSH_PASSWORD);
  expect(ollama?.prompts.at(-1)).toContain('$ sudo id -un [exit code 0]');
});

test('lets the user message the AI while a command is running', async () => {
  if (!server) throw new Error('SSH server did not start');
  // The test window is throttled to about one animation frame a second, which Playwright's click
  // waits on. A timed `sleep` can end before the click lands, so the command holds until released.
  const RELEASE = '/tmp/e2e-release-message';
  const HOLD = `echo before; until [ -e ${RELEASE} ]; do sleep 0.3; done; echo after`;
  serverExec(server, `rm -f ${RELEASE}`);
  const page = await openServerTab([`RUN: ${HOLD}`, 'FINISHED: Followed the new instruction.']);
  await startTask(page, 'Print two words');

  const bar = agentBar(page);
  await expect(bar).toContainText('Running', { timeout: 60_000 });

  await bar.getByRole('button', { name: 'Message' }).click();
  const box = bar.getByRole('textbox', { name: 'Message to the AI' });
  await expect(box).toBeFocused();
  await expect(box).toHaveAttribute('placeholder', /when the command finishes/);
  await box.fill('say goodbye as well');
  await box.press('Enter');

  // The command keeps going, and the bar says the message is waiting for it to end.
  await expect(bar).toContainText('Sent. The AI reads it when the command finishes.');
  await expect(bar.getByText('Message queued')).toBeVisible();
  await expect(box).toHaveValue('');
  await expect(bar).toContainText('Running');

  serverExec(server, `touch ${RELEASE}`);
  await expect(bar).toContainText('Followed the new instruction.', { timeout: 60_000 });
  await expect(bar.getByText('Message queued')).toBeHidden();
  await expect(bar.getByRole('textbox', { name: 'Message to the AI' })).toBeHidden();

  // The command was left alone, and the AI saw the message in the step after it.
  await expect.poll(() => terminalText(page)).toMatch(/^before\nafter$/m);
  expect(ollama?.prompts).toHaveLength(2);
  expect(ollama?.prompts[0]).not.toContain('The user added these while you were working');
  const last = ollama?.prompts.at(-1) ?? '';
  expect(last).toContain('The user added these while you were working');
  expect(last).toContain('- say goodbye as well');
  expect(last).toContain(`$ ${HOLD} [exit code 0]`);
  serverExec(server, `rm -f ${RELEASE}`);
});

test('shows a failing command with its error and passes the exit code on', async () => {
  const page = await openServerTab(['RUN: ls /does-not-exist', 'FINISHED: It is missing.']);
  await startTask(page, 'Look for /does-not-exist');

  await expect(agentBar(page)).toContainText('It is missing.', { timeout: 60_000 });
  await expect(terminalRows(page)).toContainText('No such file or directory');
  const text = await terminalText(page);
  expect(text).toContain(`${SHELL_PROMPT} ls /does-not-exist`);
  expect(text).toContain("ls: cannot access '/does-not-exist': No such file or directory");
  expect(text).not.toContain('Runova:');
  expect(ollama?.prompts.at(-1)).toContain('$ ls /does-not-exist [exit code 2]');
});

test('shows a long question in full, takes the answer, and continues the task from History', async () => {
  const QUESTION =
    'I found three nginx sites on this server: default, api.example.com and staging.example.com. Only staging.example.com changed today. Which one should I reload, and should I test the config first?';
  const page = await openServerTab([
    `NEEDS_INPUT: ${QUESTION}`,
    'RUN: echo reloaded-staging',
    'FINISHED: Reloaded staging.',
    'FINISHED: Checked https on staging.',
  ]);
  await startTask(page, 'Reload the nginx site that changed');

  // The bar line says what it waits for, and the whole question sits under it.
  const bar = agentBar(page);
  await expect(bar).toContainText('Waiting for your answer', { timeout: 60_000 });
  await expect(bar.getByRole('region', { name: 'The AI asks' })).toContainText(QUESTION);
  const answer = bar.getByRole('textbox', { name: 'Your answer' });
  await expect(answer).toBeFocused();
  await answer.fill('staging, and yes test it first');
  await answer.press('Enter');
  await expect(bar).toContainText('Reloaded staging.', { timeout: 60_000 });

  // A task on a saved server is written to disk, so it outlives the app.
  const historyFile = join(launched?.userDataDir ?? '', 'data', 'ssh-agent-history.json');
  await expect
    .poll(() => (existsSync(historyFile) ? readFileSync(historyFile, 'utf-8') : ''), {
      timeout: 10_000,
    })
    .toContain('Reload the nginx site that changed');

  // History picks the finished task back up with what to do next.
  await bar.getByRole('button', { name: 'History' }).click();
  const history = page.getByRole('dialog', { name: 'AI task history' });
  const next = history.getByRole('textbox', { name: 'What to do next' });
  await next.fill('now check that https works on it');
  await next.press('Enter');

  await expect(bar).toContainText('Checked https on staging.', { timeout: 60_000 });
  // The new task was told what the first one did, and links back to it.
  const prompt = ollama?.prompts.at(-1) ?? '';
  expect(prompt).toContain('User\'s task: "now check that https works on it"');
  expect(prompt).toContain('Earlier task: "Reload the nginx site that changed"');
  expect(prompt).toContain('[You answered]: staging, and yes test it first');
  expect(prompt).toContain('$ echo reloaded-staging [exit code 0]');
  await expect(
    history.getByRole('button', { name: 'Continues: Reload the nginx site that changed' }),
  ).toBeVisible({ timeout: 20_000 });
});
