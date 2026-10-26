import {
  closeSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
  writeSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, join } from 'node:path';
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
 *
 * The second test is about a transfer the user leaves to work elsewhere. A folder goes up with
 * one file already on the server, so the batch waits for an answer however fast the link is.
 * From the Dashboard the status bar and a toast say so, without a dialog over an unrelated page.
 * The file manager then docks in the bottom panel, where the question opens, and pops out into its
 * own window, where a second upload asks there and nowhere else. It comes back to the main window,
 * all on the same session. At the end the big file on the server has every byte and both answers
 * (keep both) show as `index (1).html` and `index (2).html`.
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

/**
 * The folder of the second test: a big file, and an index.html the server already has. The
 * conflict on index.html is what keeps the batch open, so the size only has to make the upload
 * worth watching; the test does not depend on how fast it goes.
 */
const BUNDLE = 'bundle';
const BIG_FILE = 'big.bin';
const BIG_MB = 300;
const BIG_DIR = '/tmp/transfers';
const BUNDLE_DIR = `${BIG_DIR}/${BUNDLE}`;

let server: SshTestServer | undefined;
let launched: LaunchedApp | undefined;
let localRoot = '';
let bigRoot = '';

/** Writes `mb` megabytes in 1 MB blocks that are not all zeros. */
function writeBigFile(path: string, mb: number): void {
  const block = Buffer.alloc(1024 * 1024);
  for (let i = 0; i < block.length; i += 1) block[i] = (i * 31 + 7) & 0xff;
  const fd = openSync(path, 'w');
  try {
    for (let i = 0; i < mb; i += 1) {
      block[0] = i & 0xff;
      writeSync(fd, block);
    }
  } finally {
    closeSync(fd);
  }
}

test.beforeAll(async () => {
  test.setTimeout(600_000);
  server = await startSshServer();
  localRoot = mkdtempSync(join(tmpdir(), 'runova-sftp-e2e-'));
  for (const [rel, content] of Object.entries(SITE_FILES)) {
    const parts = rel.split('/');
    mkdirSync(join(localRoot, 'site', ...parts.slice(0, -1)), { recursive: true });
    writeFileSync(join(localRoot, 'site', ...parts), content);
  }
  bigRoot = mkdtempSync(join(tmpdir(), 'runova-sftp-big-'));
  mkdirSync(join(bigRoot, BUNDLE));
  writeBigFile(join(bigRoot, BUNDLE, BIG_FILE), BIG_MB);
  writeFileSync(join(bigRoot, BUNDLE, 'index.html'), '<h1>New</h1>');
});

test.afterAll(() => {
  server?.stop();
  if (localRoot) rmSync(localRoot, { recursive: true, force: true });
  if (bigRoot) rmSync(bigRoot, { recursive: true, force: true });
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
  // Opening the field fills in the pane's folder a frame later. In the throttled e2e window that
  // can land between fill's select-all and its typing, which then appends to the old folder.
  await expect(async () => {
    await field.fill(path);
    // A couple of frames for a late reset to show, with a cap since a hidden window may not paint.
    await field.evaluate(
      () =>
        new Promise((done) => {
          setTimeout(done, 500);
          requestAnimationFrame(() => requestAnimationFrame(done));
        }),
    );
    await expect(field).toHaveValue(path, { timeout: 1_000 });
  }).toPass({ timeout: 20_000 });
  await field.press('Enter');
  const crumbs = page.getByRole('navigation', {
    name: side === 'local' ? 'Folder on this computer' : 'Folder on the server',
  });
  await expect(crumbs.locator('[aria-current="location"]')).toHaveText(lastCrumb);
}

/** Saves the server through the app, so the password is encrypted the way a real save does it. */
async function saveServer(page: Page, { changedKey = true } = {}): Promise<string> {
  if (!server) throw new Error('SSH server did not start');
  await page.evaluate(
    (input) =>
      (
        window as unknown as { runova: { ssh: { saveServer(i: unknown): Promise<unknown> } } }
      ).runova.ssh.saveServer(input),
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
  if (!changedKey) return servers[0].id;
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

test('keeps transfers going and in reach from anywhere', async () => {
  test.setTimeout(300_000);
  launched = await launchApp({});
  const { app, page } = launched;
  await page.setViewportSize({ width: 1400, height: 900 });
  const serverId = await saveServer(page, { changedKey: false });
  const localSize = statSync(join(bigRoot, BUNDLE, BIG_FILE)).size;
  // index.html is on the server already, so the upload stops on it and asks.
  onServer('mkdir -p "$1" && printf "<h1>Old</h1>" > "$1/index.html"', [BUNDLE_DIR]);

  const segment = page.getByRole('button', { name: /^File transfers/ });
  const conflictTitle = 'This file already exists';
  const waitingToast = page.getByText(`${NICKNAME} needs your answer`);

  // 1. Remote > SSH > Files. A server never trusted before is trusted on first use, so no prompt.
  await page.evaluate(() => {
    location.hash = '#/remote';
  });
  await page.getByRole('button', { name: 'SSH', exact: true }).click();
  const serverRow = page.getByRole('listitem').filter({ hasText: NICKNAME });
  await expect(serverRow).toBeVisible({ timeout: 30_000 });
  await serverRow.getByRole('button', { name: 'Files', exact: true }).click();
  await expectFilesPage(page, serverId);
  await expect(page.getByRole('button', { name: 'Trust the new key' })).toHaveCount(0);

  await goTo(page, 'local', bigRoot, basename(bigRoot));
  await goTo(page, 'remote', BIG_DIR, 'transfers');
  await row(page, 'local', BUNDLE).click();
  await expect(row(page, 'local', BUNDLE)).toHaveAttribute('aria-selected', 'true');
  const upload = pane(page, 'local').getByRole('button', { name: 'Upload to server' });
  await expect(upload).toBeEnabled();

  // 2. Upload, and straight to the Dashboard through the sidebar. Both clicks go in one task: the
  // question comes back from the server a moment later, and a person leaving the page that fast
  // is the case under test (on the page itself the dialog would open, which is right there).
  const uploadButton = await upload.elementHandle();
  const dashboardLink = await page.getByRole('link', { name: 'Dashboard' }).elementHandle();
  await page.evaluate(
    ([first, second]) => {
      (first as HTMLElement).click();
      (second as HTMLElement).click();
    },
    [uploadButton, dashboardLink],
  );
  await expect(page.getByRole('button', { name: 'Edit layout' })).toBeVisible({ timeout: 30_000 });
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');
  await expect(grid(page, 'remote')).toHaveCount(0);

  // The status bar says a question waits, and so does a toast. No dialog opens over the
  // Dashboard, which shows nothing of that server.
  await expect(segment).toContainText('Needs your answer', { timeout: 60_000 });
  await expect(waitingToast).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('dialog', { name: conflictTitle })).toHaveCount(0);

  // 3. The popover lists the batch and offers the answer. One Escape closes it.
  await segment.click();
  const popover = page.getByRole('dialog').filter({ hasText: 'File transfers' });
  await expect(popover).toBeVisible();
  const popoverServer = popover.getByRole('region', { name: NICKNAME });
  await expect(popoverServer).toContainText(BUNDLE);
  await expect(
    popoverServer.getByRole('progressbar', { name: /^bundle.* progress$/ }),
  ).toBeVisible();
  await expect(
    popoverServer.getByRole('button', { name: `Answer the question on ${NICKNAME}` }),
  ).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(popover).toBeHidden();

  // 4. From the popover into the bottom panel. Its queue starts folded to a summary that shows
  // the batch waiting. The panel shows the server's files, so the question opens there now, in
  // place of the toast. That dialog is modal and hides the rest of the window from the
  // accessibility tree, so the panel is found by its markup while it is up.
  await segment.click();
  await expect(popover).toBeVisible();
  await popover
    .getByRole('button', { name: `Show the file manager of ${NICKNAME} in the panel` })
    .click();
  await expect(popover).toBeHidden();
  const drawer = page.locator('[data-terminal-drawer]');
  const dock = drawer.locator(`[data-sftp-dock="${serverId}"] [data-sftp-view="dock"]`);
  await expect(dock).toBeVisible({ timeout: 30_000 });
  await expect(drawer.locator('[data-sftp-tab]')).toHaveCount(1);
  const dockQueue = dock.locator('section[aria-label="Transfers"]');
  await expect(dockQueue.locator('button[aria-label="Show transfers"]')).toHaveAttribute(
    'aria-expanded',
    'false',
  );
  await expect(dockQueue).toContainText('1 waiting for you');
  await expect.poll(() => page.evaluate(() => location.hash)).toBe('#/');

  // 5. The question, answered in the panel's window: keep both. The dialog is modal, so this is
  // where a person has to answer before the panel's buttons are in reach again.
  const conflict = page.getByRole('dialog', { name: conflictTitle });
  await expect(conflict).toBeVisible({ timeout: 30_000 });
  await expect(waitingToast).toHaveCount(0);
  await expect(conflict).toContainText('index.html');
  await conflict.getByRole('button', { name: 'Keep both' }).click();
  await expect(conflict).toBeHidden({ timeout: 30_000 });
  await expect(dockQueue).not.toContainText('waiting for you');

  // 6. From the panel into a window of its own, on the same session with the same queue.
  const opened = app.waitForEvent('window', {
    predicate: (win) => win.url().includes('sftp-window'),
    timeout: 60_000,
  });
  await dock.getByRole('button', { name: 'Open in a new window' }).click();
  const popout = await opened;
  await popout.waitForLoadState('domcontentloaded');
  expect(popout.url()).toContain(`server=${encodeURIComponent(serverId)}`);
  // The panel tab steps aside once the window has the files.
  await expect(drawer.locator('[data-sftp-tab]')).toHaveCount(0, { timeout: 30_000 });

  await expect(grid(popout, 'remote')).toBeVisible({ timeout: 60_000 });
  await expect(grid(popout, 'local')).toBeVisible();
  // The batch from the main window is in this window's queue: the same session, not a new one.
  const windowQueue = popout.getByRole('region', { name: 'Transfers' });
  await expect(windowQueue).toContainText(BUNDLE, { timeout: 30_000 });
  await expect(popout.getByRole('dialog', { name: conflictTitle })).toHaveCount(0);
  // The server pane of the window lists the folder the upload went to.
  await goTo(popout, 'remote', BUNDLE_DIR, BUNDLE);
  await expect(row(popout, 'remote', 'index.html')).toBeVisible({ timeout: 30_000 });
  await expect(windowQueue.getByText('Cancelled', { exact: true })).toHaveCount(0);
  await expect(windowQueue.getByText(/^Failed/)).toHaveCount(0);

  // A question asked while the window shows the files opens in the window, and only there: the
  // main window is on the Dashboard. index.html once more, after the first copy is written so the
  // two answers do not race for the same free name.
  await expect.poll(() => listed(BUNDLE_DIR), { timeout: 60_000 }).toContain('index (1).html');
  await goTo(popout, 'local', join(bigRoot, BUNDLE), BUNDLE);
  await row(popout, 'local', 'index.html').dblclick();
  const windowConflict = popout.getByRole('dialog', { name: conflictTitle });
  await expect(windowConflict).toBeVisible({ timeout: 30_000 });
  await expect(windowConflict).toContainText('index (2).html');
  await expect(page.getByRole('dialog', { name: conflictTitle })).toHaveCount(0);
  await windowConflict.getByRole('button', { name: 'Keep both' }).click();
  await expect(windowConflict).toBeHidden({ timeout: 30_000 });
  await expect.poll(() => listed(BUNDLE_DIR), { timeout: 60_000 }).toContain('index (2).html');

  // 7. Back to the main window: the pop-out closes and the main window shows the page.
  const closed = popout.waitForEvent('close', { timeout: 30_000 });
  await popout.getByRole('button', { name: 'Back to main window' }).first().click();
  await closed;
  await expect
    .poll(() => page.evaluate(() => location.hash), { timeout: 30_000 })
    .toBe(`#/ssh-files/${serverId}`);
  await expect(grid(page, 'remote')).toBeVisible({ timeout: 60_000 });
  const pageQueue = page.getByRole('region', { name: 'Transfers' });
  await expect(pageQueue).toContainText(BUNDLE);

  // 8. Both batches finish, never cancelled or failed on the way, with every byte on the server
  // and every copy of index.html.
  await expect(pageQueue.getByText('Done', { exact: true })).toHaveCount(2, { timeout: 180_000 });
  await expect(pageQueue.getByText('Cancelled', { exact: true })).toHaveCount(0);
  await expect(pageQueue.getByText(/^Failed/)).toHaveCount(0);
  expect(onServer('stat -c %s "$1"', [`${BUNDLE_DIR}/${BIG_FILE}`])).toBe(String(localSize));
  expect(listed(BUNDLE_DIR)).toBe('big.bin,index (1).html,index (2).html,index.html,');
  expect(onServer('cat "$1"', [`${BUNDLE_DIR}/index.html`])).toBe('<h1>Old</h1>');
  expect(onServer('cat "$1"', [`${BUNDLE_DIR}/index (1).html`])).toBe('<h1>New</h1>');
  expect(onServer('cat "$1"', [`${BUNDLE_DIR}/index (2).html`])).toBe('<h1>New</h1>');
  // With nothing left to move or answer, the status bar item goes away.
  await expect(segment).toHaveCount(0, { timeout: 30_000 });
});
