import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import {
  dockerAvailable,
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  serverExec,
  startSshServer,
} from './sshServer';

/**
 * A saved server's AI history, through the real app against a real SSH server (Docker): the
 * Claude Code and Codex conversations stored there show up by folder, a search narrows them, and
 * Resume opens an SSH tab that changes into the folder and runs the CLI's resume command. Neither
 * CLI is installed on the test server, so the resumed command fails there, which is fine: what
 * matters is what got typed.
 */

test.skip(!dockerAvailable(), 'needs Docker to start the test SSH server');

const HOME = `/home/${SSH_USER}`;
const NICKNAME = 'E2E server';

const TITLED = {
  id: '3f2a9c1e-5b7d-4e8a-9c0f-1a2b3c4d5e6f',
  title: 'Fix the deploy pipeline',
  prompt: 'Why does the deploy fail on staging?',
};
const UNTITLED = {
  id: '8d4e1f2a-6c3b-4a9d-8e7f-2b3c4d5e6f70',
  prompt: 'Add a health check endpoint to the API',
};
const SCRIPTS = {
  id: 'c7b6a5d4-1e2f-4a3b-9c8d-7e6f5a4b3c2d',
  prompt: 'Write a backup script for the database',
};
const CODEX = {
  id: '0199a1b2-c3d4-7e5f-8a9b-0c1d2e3f4a5b',
  prompt: 'Tune the nginx config for websockets',
};

let server: SshTestServer | undefined;
let launched: LaunchedApp | undefined;

const jsonl = (...records: unknown[]): string =>
  `${records.map((r) => JSON.stringify(r)).join('\n')}\n`;

function claudeTranscript(id: string, cwd: string, prompt: string, title?: string): string {
  const at = '2026-10-01T10:00:00.000Z';
  return jsonl(
    {
      type: 'user',
      sessionId: id,
      cwd,
      timestamp: at,
      message: { role: 'user', content: prompt },
    },
    {
      type: 'assistant',
      sessionId: id,
      cwd,
      timestamp: '2026-10-01T10:00:05.000Z',
      message: { role: 'assistant', content: [{ type: 'text', text: 'On it.' }] },
    },
    ...(title ? [{ type: 'custom-title', customTitle: title, sessionId: id }] : []),
  );
}

function codexRollout(id: string, cwd: string, prompt: string): string {
  return jsonl(
    {
      timestamp: '2026-10-01T09:30:00.000Z',
      type: 'session_meta',
      payload: { id, cwd, timestamp: '2026-10-01T09:30:00.000Z', originator: 'codex_cli_rs' },
    },
    {
      timestamp: '2026-10-01T09:30:01.000Z',
      type: 'event_msg',
      payload: { type: 'user_message', message: prompt },
    },
  );
}

/** Writes a file on the server as the login user, dated `ago` (anything `touch -d` reads). */
function seed(path: string, content: string, ago: string): void {
  if (!server) throw new Error('SSH server did not start');
  serverExec(server, 'mkdir -p "$(dirname "$1")" && cat > "$1" && touch -d "$2" "$1"', {
    input: content,
    args: [path, ago],
  });
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  server = await startSshServer();
  // The folders the conversations ran in, so the resumed `cd` lands somewhere.
  serverExec(server, `mkdir -p /srv/app && chown ${SSH_USER} /srv/app`, { user: 'root' });
  serverExec(server, `mkdir -p ${HOME}/scripts`);

  seed(
    `${HOME}/.claude/projects/-srv-app/${TITLED.id}.jsonl`,
    claudeTranscript(TITLED.id, '/srv/app', TITLED.prompt, TITLED.title),
    '2 hours ago',
  );
  seed(
    `${HOME}/.claude/projects/-srv-app/${UNTITLED.id}.jsonl`,
    claudeTranscript(UNTITLED.id, '/srv/app', UNTITLED.prompt),
    '1 day ago',
  );
  seed(
    `${HOME}/.claude/projects/-home-${SSH_USER}-scripts/${SCRIPTS.id}.jsonl`,
    claudeTranscript(SCRIPTS.id, `${HOME}/scripts`, SCRIPTS.prompt),
    '3 days ago',
  );
  seed(
    `${HOME}/.codex/sessions/2026/10/01/rollout-2026-10-01T09-30-00-${CODEX.id}.jsonl`,
    codexRollout(CODEX.id, '/srv/app', CODEX.prompt),
    '5 hours ago',
  );
});

test.afterAll(() => {
  server?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** The active terminal tab's visible rows, as text. */
function terminalRows(page: Page): Locator {
  return page.locator('.terminal-pane .xterm-rows');
}

/** The terminal text with wrapped rows joined back up, so a long command reads as one line. */
async function terminalText(page: Page): Promise<string> {
  return (await terminalRows(page).innerText()).replace(/ /g, ' ').replace(/\n/g, '');
}

function terminalTabs(page: Page): Locator {
  return page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');
}

function historySheet(page: Page): Locator {
  return page.getByRole('dialog', { name: NICKNAME });
}

/** A conversation row in the sheet: the row button and its hover actions. */
function historyRow(sheet: Locator, text: string): Locator {
  return sheet.locator('div.group\\/history').filter({ hasText: text });
}

async function openServersList(): Promise<Page> {
  if (!server) throw new Error('SSH server did not start');
  launched = await launchApp({});
  const { page } = launched;
  await page.setViewportSize({ width: 1400, height: 900 });

  // Saved through the app itself, so the password is encrypted the way a real save does it.
  await page.evaluate(
    (input) =>
      (
        window as unknown as { agentmat: { ssh: { saveServer(i: unknown): Promise<unknown> } } }
      ).agentmat.ssh.saveServer(input),
    {
      nickname: NICKNAME,
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
  await expect(page.getByRole('listitem').filter({ hasText: NICKNAME })).toBeVisible({
    timeout: 30_000,
  });
  return page;
}

async function openHistory(page: Page): Promise<Locator> {
  await page
    .getByRole('listitem')
    .filter({ hasText: NICKNAME })
    .getByRole('button', { name: 'AI history on this server' })
    .click();
  const sheet = historySheet(page);
  await expect(sheet).toBeVisible();
  return sheet;
}

test('lists the conversations on a server and resumes one in an SSH tab', async () => {
  // Three resumes, each waiting on a real SSH shell, plus a server probe per opening.
  test.setTimeout(300_000);
  const page = await openServersList();
  const sheet = await openHistory(page);

  // Header: the server, its address and what was found once the server answered.
  await expect(sheet.getByRole('heading', { name: NICKNAME })).toBeVisible();
  await expect(sheet).toContainText(`${SSH_USER}@${server?.host}:${server?.port}`);
  await expect(sheet).toContainText('4 conversations · 2 folders', { timeout: 60_000 });

  // Folders, the most recently active first, with the home folder written as ~.
  const srvApp = sheet.getByRole('button', { name: /^\/srv\/app, 3 conversations, last active/ });
  const scripts = sheet.getByRole('button', { name: /^~\/scripts, 1 conversation, last active/ });
  await expect(srvApp).toBeVisible();
  await expect(scripts).toBeVisible();
  await expect(srvApp).toHaveAttribute('aria-expanded', 'true');
  await expect(scripts).toHaveAttribute('aria-expanded', 'false');
  const headers = await sheet
    .locator('section button[aria-expanded]')
    .evaluateAll((buttons) => buttons.map((b) => b.getAttribute('aria-label')?.split(',')[0]));
  expect(headers).toEqual(['/srv/app', '~/scripts']);

  // The first folder is open: the titled conversation shows its title, not its first prompt.
  const srvGroup = sheet.getByRole('group', { name: '/srv/app' });
  await expect(srvGroup.getByText(TITLED.title, { exact: true })).toBeVisible();
  await expect(srvGroup.getByText(TITLED.prompt)).toHaveCount(0);
  await expect(srvGroup.getByText(UNTITLED.prompt)).toBeVisible();
  await expect(srvGroup.getByText(CODEX.prompt)).toBeVisible();
  await expect(sheet.getByText(SCRIPTS.prompt)).toHaveCount(0);

  // The CLIs are not installed on the test server, which the sheet warns about.
  await expect(sheet).toContainText('claude not found on PATH');
  await expect(sheet).toContainText('codex not found on PATH');

  // A search narrows the rows and opens every folder with a match.
  const search = sheet.getByRole('textbox', { name: 'Search conversations' });
  await expect(search).toBeFocused();
  await search.fill('backup');
  await expect(sheet.getByText(SCRIPTS.prompt)).toBeVisible();
  await expect(scripts).toHaveAttribute('aria-expanded', 'true');
  await expect(srvApp).toHaveCount(0);
  await expect(sheet.getByText(TITLED.title)).toHaveCount(0);
  await search.fill('no such conversation');
  await expect(sheet).toContainText('No conversation matches.');
  await search.fill('');
  await expect(srvApp).toHaveAttribute('aria-expanded', 'true');
  await expect(scripts).toHaveAttribute('aria-expanded', 'false');

  // The agent filter menu keeps only Codex. The menu opens in a portal, outside the sheet.
  const agentMenu = page.getByRole('menu', { name: 'Agent' });
  await sheet.getByRole('button', { name: 'Filter by agent' }).click();
  await agentMenu.getByRole('menuitemradio', { name: /Codex/ }).click();
  await expect(srvGroup.getByText(CODEX.prompt)).toBeVisible();
  await expect(sheet.getByText(TITLED.title)).toHaveCount(0);
  await sheet.getByRole('button', { name: 'Filter by agent' }).click();
  await agentMenu.getByRole('menuitemradio', { name: /All agents/ }).click();

  // Resume the titled conversation.
  await expect(terminalTabs(page)).toHaveCount(0);
  const titledRow = historyRow(sheet, TITLED.title);
  await titledRow.hover();
  await titledRow.getByRole('button', { name: 'Resume in a new tab' }).click();
  await expect(sheet).toBeHidden();

  await expect(terminalTabs(page)).toHaveCount(1);
  const titledTab = terminalTabs(page).filter({ hasText: `${NICKNAME} · ${TITLED.title}` });
  await expect(titledTab).toHaveAttribute('aria-selected', 'true');
  // The shell echoes what the tab typed; the drawer is short, so make room for it first.
  await page.getByRole('button', { name: 'Maximize terminal' }).click();
  await expect
    .poll(() => terminalText(page), { timeout: 60_000 })
    .toContain(`cd -- /srv/app && claude --resume ${TITLED.id}`);
  await expect
    .poll(() => terminalText(page), { timeout: 30_000 })
    .toContain('claude: command not found');
  await page.getByRole('button', { name: 'Restore terminal' }).click();

  // Back in the sheet the conversation reads as open and has no Resume button of its own.
  const again = await openHistory(page);
  const openRow = historyRow(again, TITLED.title);
  await expect(openRow).toContainText('Open', { timeout: 60_000 });
  await openRow.hover();
  await expect(openRow.getByRole('button', { name: 'Resume in a new tab' })).toHaveCount(0);

  // A second conversation gets a tab of its own, which becomes the active one.
  const codexRow = historyRow(again, CODEX.prompt);
  await codexRow.hover();
  await codexRow.getByRole('button', { name: 'Resume in a new tab' }).click();
  await expect(again).toBeHidden();
  await expect(terminalTabs(page)).toHaveCount(2);
  await expect(
    terminalTabs(page).filter({ hasText: `${NICKNAME} · ${CODEX.prompt}` }),
  ).toHaveAttribute('aria-selected', 'true');
  await expect
    .poll(() => terminalText(page), { timeout: 60_000 })
    .toContain(`cd -- /srv/app && codex resume ${CODEX.id}`);

  // Resuming the first one again brings its tab back instead of opening a third. An open
  // conversation has no Resume button, so this clicks the row itself, which resumes too.
  const third = await openHistory(page);
  await historyRow(third, TITLED.title).getByRole('button').first().click();
  await expect(third).toBeHidden();
  await expect(terminalTabs(page)).toHaveCount(2);
  await expect(titledTab).toHaveAttribute('aria-selected', 'true');
  await expect.poll(() => terminalText(page)).toContain(`claude --resume ${TITLED.id}`);
});
