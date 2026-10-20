import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
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
 * The SFTP file manager (E25) through the real app against a real SSH server (Docker). A saved
 * server whose trusted key no longer matches opens from its Files button and asks to trust the
 * new key. A folder typed into the local path bar goes up to /tmp; a second upload asks about
 * every file already there and keeps both copies for all of them. Then a file is edited and
 * saved on the server, its permissions set to 600, and the folder deleted after typing the
 * confirmation word. Last, the page opens again from the terminal drawer of an SSH tab and from
 * the command palette. What the server holds is checked over `docker exec` after each step.
 */

test.skip(!dockerAvailable(), 'needs Docker to start the test SSH server');

const NICKNAME = 'E2E server';
const REMOTE_DIR = '/tmp';
const SITE = `${REMOTE_DIR}/site`;
const PALETTE_PLACEHOLDER = 'Search projects, history, skills…';

/** The folder uploaded: four files, so the conflict dialog has others to apply the answer to. */
const SITE_FILES: Record<string, string> = {
  'index.html': '<h1>Hello</h1>\n',
  'about.html': '<p>About</p>\n',
  'css/style.css': 'body { color: red; }\n',
  'js/app.js': 'console.log("hi");\n',
};

let server: SshTestServer | undefined;
let launched: LaunchedApp | undefined;
let localRoot = '';

test.beforeAll(async () => {
  test.setTimeout(600_000);
  server = await startSshServer();
  localRoot = mkdtempSync(join(tmpdir(), 'agentmate-sftp-e2e-'));
  for (const [rel, content] of Object.entries(SITE_FILES)) {
    const parts = rel.split('/');
    mkdirSync(join(localRoot, 'site', ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(localRoot, 'site', ...parts), content);
  }
});

test.afterAll(() => {
  server?.stop();
  if (localRoot) rmSync(localRoot, { recursive: true, force: true });
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

function onServer(command: string, args: string[] = []): string {
  if (!server) throw new Error('SSH server did not start');
  return serverExec(server, command, { args });
}

/** The names in a folder on the server, sorted, or MISSING when it is not there. */
function listed(path: string): string {
  return onServer('[ -d "$1" ] && ls -A "$1" | sort | tr "\\n" "," || echo MISSING', [path]);
}

function pane(page: Page, side: 'local' | 'remote'): Locator {
  return page.getByRole('region', {
    name: side === 'local' ? 'This computer' : `Server ${NICKNAME}`,
  });
}

function grid(page: Page, side: 'local' | 'remote'): Locator {
  return page.locator(`[data-sftp-grid="${side}"]`);
}

function row(page: Page, side: 'local' | 'remote', name: string): Locator {
  return grid(page, side).locator(`[data-sftp-row="${name}"]`);
}

/** Types a folder into a pane's path bar and waits for the pane to show it. */
async function goTo(page: Page, side: 'local' | 'remote', path: string, lastCrumb: string) {
  await page.getByTestId(`${side}-path-space`).click();
  const field = page.getByRole('textbox', {
    name: side === 'local' ? 'Folder on this computer' : 'Folder on the server',
  });
  await field.fill(path);
  await field.press('Enter');
  const crumbs = page.getByRole('navigation', {
    name: side === 'local' ? 'Folder on this computer' : 'Folder on the server',
  });
  await expect(crumbs.locator('[aria-current="location"]')).toHaveText(lastCrumb);
}

/** Saves the server through the app, so the password is encrypted the way a real save does it. */
async function saveServer(page: Page): Promise<string> {
  if (!server) throw new Error('SSH server did not start');
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
  if (!launched) throw new Error('The app did not start');
  // A key trusted before that the server no longer shows, as after a reinstall. The store reads
  // this file on every call, so the next connect sees it.
  const file = join(launched.userDataDir, 'data', 'ssh-servers.json');
  const servers = JSON.parse(readFileSync(file, 'utf-8')) as {
    id: string;
    hostKeyFingerprint?: string;
  }[];
  expect(servers).toHaveLength(1);
  servers[0].hostKeyFingerprint = 'ab'.repeat(32);
  writeFileSync(file, JSON.stringify(servers, null, 2));
  return servers[0].id;
}

async function expectFilesPage(page: Page, serverId: string): Promise<void> {
  await expect.poll(() => page.evaluate(() => location.hash)).toBe(`#/ssh-files/${serverId}`);
  await expect(page.getByText(`Files: ${NICKNAME}`).first()).toBeVisible();
  await expect(grid(page, 'remote')).toBeVisible({ timeout: 60_000 });
  await expect(grid(page, 'local')).toBeVisible();
}

test('moves a folder to a server and back through every step of the file manager', async () => {
  test.setTimeout(300_000);
  launched = await launchApp({});
  const { page } = launched;
  await page.setViewportSize({ width: 1400, height: 900 });
  const serverId = await saveServer(page);

  // 1. Remote > SSH > Files, and the changed host key is trusted from the prompt.
  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await page.getByRole('button', { name: 'SSH', exact: true }).click();
  const serverRow = page.getByRole('listitem').filter({ hasText: NICKNAME });
  await expect(serverRow).toBeVisible({ timeout: 30_000 });
  await serverRow.getByRole('button', { name: 'Files', exact: true }).click();

  const trust = page.getByRole('button', { name: 'Trust the new key' });
  await expect(trust).toBeVisible({ timeout: 60_000 });
  await trust.click();
  await expectFilesPage(page, serverId);
  await expect(
    pane(page, 'remote').getByRole('navigation', { name: 'Folder on the server' }),
  ).toContainText(SSH_USER);

  // 2. The local temp folder typed into the path bar, the server pane moved to /tmp, and the
  // folder uploaded with the toolbar button.
  await goTo(page, 'local', localRoot, localRoot.split(/[\\/]/).at(-1) ?? '');
  await goTo(page, 'remote', REMOTE_DIR, 'tmp');
  await row(page, 'local', 'site').click();
  await expect(row(page, 'local', 'site')).toHaveAttribute('aria-selected', 'true');
  await pane(page, 'local').getByRole('button', { name: 'Upload to server' }).click();

  await expect.poll(() => listed(SITE), { timeout: 60_000 }).toBe('about.html,css,index.html,js,');
  await expect.poll(() => listed(`${SITE}/css`)).toBe('style.css,');
  expect(onServer('cat "$1"', [`${SITE}/index.html`])).toBe('<h1>Hello</h1>');
  await expect(row(page, 'remote', 'site')).toBeVisible();

  // 3. The same folder again: every file is already there. Keep both, for all of them.
  await pane(page, 'local').getByRole('button', { name: 'Upload to server' }).click();
  const conflict = page.getByRole('dialog', { name: 'This file already exists' });
  await expect(conflict).toBeVisible({ timeout: 60_000 });
  const applyToAll = conflict.getByRole('checkbox');
  await applyToAll.check();
  await expect(applyToAll).toBeChecked();
  await conflict.getByRole('button', { name: 'Keep both' }).click();
  await expect(conflict).toBeHidden();

  await expect
    .poll(() => listed(SITE), { timeout: 60_000 })
    .toBe('about (1).html,about.html,css,index (1).html,index.html,js,');
  await expect.poll(() => listed(`${SITE}/css`)).toBe('style (1).css,style.css,');
  await expect.poll(() => listed(`${SITE}/js`)).toBe('app (1).js,app.js,');
  // Nothing was overwritten.
  expect(onServer('cat "$1"', [`${SITE}/index.html`])).toBe('<h1>Hello</h1>');

  await row(page, 'remote', 'site').dblclick();
  await expect(row(page, 'remote', 'index (1).html')).toBeVisible();
  await expect(row(page, 'remote', 'about (1).html')).toBeVisible();
  await expect(row(page, 'remote', 'index.html')).toBeVisible();

  // 4. index.html edited on the server and saved.
  await row(page, 'remote', 'index.html').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Edit', exact: true }).click();
  const editor = page.getByRole('dialog', { name: `${SITE}/index.html` });
  await expect(editor).toBeVisible();
  const monaco = editor.locator('.monaco-editor');
  await expect(monaco).toBeVisible({ timeout: 30_000 });
  await expect(monaco.locator('.view-lines')).toContainText('Hello');
  await monaco.locator('.view-lines').click();
  await page.keyboard.press('Control+A');
  await page.keyboard.type('Edited over SFTP');
  // The e2e window paints slowly, so Monaco takes in the typing a moment after the keys went in.
  // Ctrl+S before the chip changes finds nothing to save and does nothing.
  await expect(monaco.locator('.view-lines')).toHaveText('Edited over SFTP');
  await expect(editor.getByText('Unsaved changes', { exact: true })).toBeVisible();
  await page.keyboard.press('Control+S');
  await expect(editor.getByText('Saved', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => onServer('cat "$1"', [`${SITE}/index.html`])).toBe('Edited over SFTP');
  await editor.getByRole('button', { name: 'Close' }).click();
  await expect(editor).toBeHidden();

  // 5. Its permissions set to 600 in the properties dialog.
  await row(page, 'remote', 'index.html').click({ button: 'right' });
  await page.getByRole('menuitem', { name: 'Permissions and properties' }).click();
  const properties = page.getByRole('dialog', { name: 'index.html' });
  await expect(properties).toBeVisible();
  await properties.getByLabel('Octal').fill('600');
  await properties.getByRole('button', { name: 'Apply' }).click();
  await expect(properties).toBeHidden({ timeout: 30_000 });
  await expect
    .poll(() => onServer('stat -c %a "$1"', [`${SITE}/index.html`]), { timeout: 30_000 })
    .toBe('600');
  await expect(row(page, 'remote', 'index.html')).toContainText('-rw-------');

  // 6. Back in /tmp, the folder deleted: a folder this close to the root needs the word typed.
  await pane(page, 'remote').getByRole('button', { name: 'Up one folder' }).click();
  await expect(
    pane(page, 'remote')
      .getByRole('navigation', { name: 'Folder on the server' })
      .locator('[aria-current="location"]'),
  ).toHaveText('tmp');
  await row(page, 'remote', 'site').click({ button: 'right' });
  // The item's name ends with its shortcut, Del.
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const confirm = page.getByRole('dialog', { name: `Delete "site" from ${NICKNAME}?` });
  await expect(confirm).toBeVisible();
  const deleteButton = confirm.getByRole('button', { name: 'Delete', exact: true });
  await expect(deleteButton).toBeDisabled();
  await confirm.getByLabel(/to confirm/).fill('delete');
  await deleteButton.click();
  await expect(confirm).toBeHidden();
  await expect.poll(() => listed(SITE), { timeout: 60_000 }).toBe('MISSING');
  await expect(row(page, 'remote', 'site')).toHaveCount(0);

  // 7a. From the terminal drawer of an SSH tab on the server, opened from Remote.
  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await page.getByRole('button', { name: 'SSH', exact: true }).click();
  await serverRow.getByRole('button', { name: 'Connect' }).click();
  const tabs = page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');
  await expect(tabs).toHaveCount(1, { timeout: 60_000 });
  await expect(grid(page, 'remote')).toHaveCount(0);
  await page
    .getByRole('region', { name: 'Terminal' })
    .getByRole('button', { name: 'Browse files over SFTP' })
    .click();
  await expectFilesPage(page, serverId);

  // 7b. From the command palette, found by the server's name.
  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await expect(grid(page, 'remote')).toHaveCount(0);
  const palette = page.getByPlaceholder(PALETTE_PLACEHOLDER);
  await expect(async () => {
    await page.keyboard.press('Control+K');
    await expect(palette).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
  await palette.fill(NICKNAME);
  await page.getByRole('option', { name: new RegExp(`Open SFTP files: ${NICKNAME}`) }).click();
  await expect(palette).toBeHidden();
  await expectFilesPage(page, serverId);
});
