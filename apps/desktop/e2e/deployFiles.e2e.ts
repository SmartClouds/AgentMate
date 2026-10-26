import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { systemTestsEnabled } from '../src/main/deploy/testing/testServerMachines';
import { createProject, type LaunchedApp, launchApp } from './app';
import { type FtpTestServer, startFtpServer } from './ftpServer';
import {
  SSH_PASSWORD,
  SSH_USER,
  type SshTestServer,
  serverExec,
  startSshServer,
} from './sshServer';

/**
 * FTP and SFTP sites through the built app, end to end (E23).
 *
 * The first story runs against the Docker OpenSSH server with a login of the site's own:
 * 1. the site is added from Deploy, its host key trusted in Test connection, the server folder
 *    picked in the browser, and the project attached;
 * 2. the three files of the deploy folder deploy and show in History;
 * 3. an edit, a delete and an agent file: the agent file is left out and never sent, the delete
 *    is confirmed, and a file only on the server is never touched;
 * 4. a file changed on both sides is a conflict: Skip keeps the server's copy, Overwrite sends ours;
 * 5. Deploy on save sends an edit by itself and History says so;
 * 6. the project's Deploy tab shows the site, counts the pending change in its badge and deploys.
 *
 * The second is short: FTPS against ProFTPD, whose self-signed certificate is trusted in Test
 * connection before one file deploys.
 *
 * Needs RUNOVA_SYSTEM_TESTS=1 and Docker for Linux containers. The containers are named
 * runova-e2e-ssh-* and runova-e2e-ftp-* and removed in afterAll.
 */

test.skip(!systemTestsEnabled(), 'needs RUNOVA_SYSTEM_TESTS=1 and Docker for Linux containers');

const MINUTE = 60_000;
/** A test, a plan or a deploy over a container on a machine that is often busy. */
const SERVER_TIMEOUT = 2 * MINUTE;
const PROJECT_NAME = 'e2e project';

/** Writes `content` to `path` (slash separated) under `root`, making its folders. */
function writeUnder(root: string, path: string, content: string): void {
  const full = join(root, ...path.split('/'));
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

/** The FTP and SFTP site's add or edit dialog, filled for a login of the site's own. */
async function fillLogin(
  dialog: Locator,
  login: {
    protocol: 'SFTP' | 'FTPS';
    host: string;
    port: number;
    username: string;
    password: string;
    localFolder: string;
    remoteRoot: string;
  },
): Promise<void> {
  const protocol = dialog.getByRole('group', { name: 'Protocol' });
  await protocol.getByRole('button', { name: login.protocol, exact: true }).click();
  await expect(protocol.getByRole('button', { name: login.protocol, exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
  if (login.protocol === 'SFTP') {
    const source = dialog.getByRole('group', { name: 'Login' });
    await source.getByRole('button', { name: 'Enter a login' }).click();
    await expect(source.getByRole('button', { name: 'Enter a login' })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
  }
  await dialog.getByLabel('Host', { exact: true }).fill(login.host);
  await dialog.getByLabel('Port', { exact: true }).fill(String(login.port));
  await dialog.getByLabel('Username', { exact: true }).fill(login.username);
  await dialog.getByLabel('Password', { exact: true }).fill(login.password);
  await dialog.getByLabel('Deploy folder', { exact: true }).fill(login.localFolder);
  await dialog.getByLabel('Folder on the server', { exact: true }).fill(login.remoteRoot);
}

/** Test connection passed, with or without things to know. */
function testPassed(dialog: Locator): Locator {
  return dialog
    .getByText('Everything works. The site is ready to save.')
    .or(dialog.getByText(/^Works, with \d+ things? to know\. You can save the site\.$/));
}

/** The Changes card of a site: what is waiting and the Deploy button. */
function changesCard(scope: Page | Locator): Locator {
  return scope.getByRole('region', { name: 'Changes', exact: true });
}

/** How the last deploy ended, the card above the list. */
function lastDeploy(scope: Page | Locator): Locator {
  return scope.getByRole('region', { name: 'Last deploy' });
}

test.describe('An SFTP site from Deploy and from a project', () => {
  // One story on one site: each step builds on what the one before deployed.
  test.describe.configure({ mode: 'serial', retries: 0 });

  const SITE_LABEL = 'SFTP e2e site';
  const REMOTE = `/home/${SSH_USER}/site`;
  const INDEX_V1 = '<!doctype html><title>v1</title>\n';
  const INDEX_V2 = '<!doctype html><title>v2, edited here</title>\n';
  const CSS_V1 = 'body { color: black; }\n';
  const APP_JS = 'console.log("app");\n';
  const SERVER_ONLY = 'only on the server\n';

  let server: SshTestServer | undefined;
  let launched: LaunchedApp | undefined;
  let folder = '';

  const page = (): Page => {
    if (!launched) throw new Error('The app did not start');
    return launched.page;
  };
  const ssh = (): SshTestServer => {
    if (!server) throw new Error('The SSH server did not start');
    return server;
  };
  const writeLocal = (path: string, content: string): void => writeUnder(folder, path, content);
  /** A file under the site's server folder, read in the container. */
  const remoteFile = (path: string): string =>
    serverExec(ssh(), 'cat "$1"', { args: [`${REMOTE}/${path}`] });
  const remoteExists = (path: string): boolean =>
    serverExec(ssh(), 'if [ -e "$1" ]; then echo yes; else echo no; fi', {
      args: [`${REMOTE}/${path}`],
    }) === 'yes';

  test.beforeAll(async () => {
    test.setTimeout(15 * MINUTE);
    server = await startSshServer();
    serverExec(ssh(), 'mkdir -p "$1"', { args: [REMOTE] });
    launched = await launchApp({ settings: {} });
    // The project's folder is the deploy folder, so the project tab's prefill points at it too.
    folder = launched.projectDir;
    writeLocal('index.html', INDEX_V1);
    writeLocal('css/site.css', CSS_V1);
    writeLocal('js/app.js', APP_JS);
    await createProject(launched);
    // A project made through IPC is not in the cached list yet.
    await launched.page.reload();
    await launched.page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  });

  test.afterAll(async () => {
    test.setTimeout(2 * MINUTE);
    try {
      await launched?.close();
    } finally {
      server?.stop();
    }
  });

  /** The site's section strip under Deploy. */
  async function openSection(name: 'Changes' | 'History' | 'Settings'): Promise<void> {
    await page()
      .getByRole('navigation', { name: 'Site sections' })
      .getByRole('button', { name: new RegExp(`^${name}`) })
      .click();
  }

  test('adds an SFTP site with a login of its own, trusting the host key', async () => {
    test.setTimeout(6 * MINUTE);
    const p = page();
    await p.getByRole('link', { name: 'Deploy', exact: true }).click();
    await p.getByRole('button', { name: 'Add an FTP or SFTP site' }).first().click();

    const dialog = p.getByRole('dialog', { name: 'Add an FTP or SFTP site' });
    await fillLogin(dialog, {
      protocol: 'SFTP',
      host: ssh().host,
      port: ssh().port,
      username: SSH_USER,
      password: SSH_PASSWORD,
      localFolder: folder,
      remoteRoot: REMOTE,
    });

    // The first meeting with the server stops at its host key.
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText('First connection to this server')).toBeVisible({
      timeout: SERVER_TIMEOUT,
    });
    await expect(dialog.getByText('Fingerprint', { exact: true })).toBeVisible();
    await dialog.getByRole('button', { name: 'Trust this key' }).click();
    await expect(testPassed(dialog)).toBeVisible({ timeout: SERVER_TIMEOUT });
    await expect(dialog.getByText('Tested with these details.')).toBeVisible();
    await expect(
      dialog.getByText('Its host key is trusted. A server that shows a different one is refused.'),
    ).toBeVisible();
    const checklist = dialog.getByRole('list', { name: 'Connection test' });
    for (const step of ['Reached the server', 'Signed in', 'Found the folder', 'Can write files']) {
      await expect(checklist).toContainText(step);
    }

    // The folder browser opens at the folder in the field; going up and back in picks it again.
    await dialog.getByRole('button', { name: 'Browse' }).click();
    const browser = p.getByRole('dialog', { name: 'Choose a folder on the server' });
    const crumbs = browser.getByRole('navigation', { name: 'Folder path' });
    await expect(crumbs.getByRole('button', { name: 'site', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: SERVER_TIMEOUT },
    );
    await browser.getByRole('button', { name: 'Up one level' }).click();
    await expect(crumbs.getByRole('button', { name: SSH_USER, exact: true })).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: SERVER_TIMEOUT },
    );
    await browser
      .getByRole('list', { name: 'Folders' })
      .getByRole('button', { name: 'site', exact: true })
      .click();
    await expect(crumbs.getByRole('button', { name: 'site', exact: true })).toHaveAttribute(
      'aria-current',
      'page',
      { timeout: SERVER_TIMEOUT },
    );
    await browser.getByRole('button', { name: 'Use this folder' }).click();
    await expect(browser).toBeHidden();
    await expect(dialog.getByLabel('Folder on the server', { exact: true })).toHaveValue(REMOTE);
    // The same folder again: the test still holds.
    await expect(dialog.getByText('Tested with these details.')).toBeVisible();

    await dialog.getByRole('combobox', { name: 'Projects' }).click();
    await p.getByRole('option', { name: new RegExp(PROJECT_NAME) }).click();
    await p.keyboard.press('Escape');
    await expect(dialog.getByRole('button', { name: `Remove ${PROJECT_NAME}` })).toBeVisible();
    await expect(dialog).toBeVisible();

    await dialog.getByLabel('Name', { exact: true }).fill(SITE_LABEL);
    await dialog.getByRole('button', { name: 'Add site', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: MINUTE });

    const rail = p.getByRole('list', { name: 'FTP and SFTP sites' });
    const row = rail.getByRole('button', { name: new RegExp(SITE_LABEL) });
    await expect(row).toBeVisible();
    await expect(row).toContainText('SFTP');
    await expect(row).toContainText(`${SSH_USER}@${ssh().host}`);
    await expect(p.getByRole('heading', { name: SITE_LABEL })).toBeVisible();
  });

  test('deploys the three added files and shows the run in History', async () => {
    test.setTimeout(5 * MINUTE);
    const p = page();
    const card = changesCard(p);
    await expect(card).toContainText('3 changes', { timeout: MINUTE });
    const filters = p.getByRole('group', { name: 'Show' });
    await expect(filters.getByRole('button', { name: /^Added\s*3$/ })).toBeVisible();
    const list = p.getByRole('list', { name: 'Changed files' });
    for (const path of ['index.html', 'css/site.css', 'js/app.js']) {
      await expect(list).toContainText(path);
    }
    // The rail counts what the page shows.
    await expect(
      p
        .getByRole('list', { name: 'FTP and SFTP sites' })
        .getByRole('button', { name: new RegExp(SITE_LABEL) }),
    ).toContainText('3 to deploy');

    await card.getByRole('button', { name: /^Deploy 3 changes/ }).click();
    const result = lastDeploy(p);
    await expect(result).toContainText('Deployed', { timeout: SERVER_TIMEOUT });
    await expect(result).toContainText('3 uploaded');
    await expect(changesCard(p)).toContainText('Everything is deployed', { timeout: MINUTE });

    expect(remoteFile('index.html')).toBe(INDEX_V1.trim());
    expect(remoteFile('css/site.css')).toBe(CSS_V1.trim());
    expect(remoteFile('js/app.js')).toBe(APP_JS.trim());

    await openSection('History');
    const newest = p.getByRole('list', { name: 'Deploys' }).getByRole('listitem').first();
    await expect(newest).toContainText('Deployed', { timeout: MINUTE });
    await expect(newest).toContainText('3 uploaded');
    await expect(newest).toContainText('You');
    await openSection('Changes');
  });

  test('sends an edit and a confirmed delete, leaves out agent files and server-only files', async () => {
    test.setTimeout(5 * MINUTE);
    const p = page();
    serverExec(ssh(), 'printf "%s" "$2" > "$1"', {
      args: [`${REMOTE}/server-only.txt`, SERVER_ONLY],
    });
    writeLocal('index.html', INDEX_V2);
    rmSync(join(folder, 'js', 'app.js'));
    writeLocal('.claude/settings.json', '{ "local": "only" }\n');

    const card = changesCard(p);
    await expect(card).toContainText('2 changes', { timeout: MINUTE });
    const filters = p.getByRole('group', { name: 'Show' });
    await expect(filters.getByRole('button', { name: /^Modified\s*1$/ })).toBeVisible();
    await expect(filters.getByRole('button', { name: /^Deleted\s*1$/ })).toBeVisible();
    const list = p.getByRole('list', { name: 'Changed files' });
    await expect(list.getByRole('listitem').filter({ hasText: 'index.html' }).last()).toContainText(
      'Modified',
    );
    await expect(list.getByRole('listitem').filter({ hasText: 'js/app.js' }).last()).toContainText(
      'Deleted',
    );
    await expect(list).not.toContainText('.claude');

    await filters.getByRole('button', { name: /^Left out/ }).click();
    const leftOut = p.getByRole('list', { name: 'Left out', exact: true });
    const agentRow = leftOut.getByRole('listitem').filter({ hasText: '.claude' });
    await expect(agentRow).toHaveCount(1);
    await expect(agentRow).toContainText('Agent files');
    await filters.getByRole('button', { name: /^All/ }).click();

    await card.getByRole('button', { name: /^Deploy 2 changes/ }).click();
    const confirm = p.getByRole('dialog', { name: 'Delete 1 file from the server?' });
    // One delete out of three deployed files is more than a quarter of the site, which the
    // planner counts as a mass delete, so the review opens first with that warning.
    const review = p.getByRole('region', { name: 'Review before deploying' });
    await expect(confirm.or(review)).toBeVisible({ timeout: SERVER_TIMEOUT });
    if (await review.isVisible()) {
      await expect(review).toContainText('This deploy deletes 1 file from the server.');
      await review.getByRole('button', { name: 'Continue', exact: true }).click();
    }
    await expect(confirm).toBeVisible({ timeout: MINUTE });
    await expect(confirm).toContainText('js/app.js');
    await confirm.getByRole('button', { name: 'Delete and deploy' }).click();
    await expect(confirm).toBeHidden();

    const result = lastDeploy(p);
    await expect(result).toContainText('Deployed', { timeout: SERVER_TIMEOUT });
    await expect(result).toContainText('1 uploaded, 1 deleted');
    await expect(changesCard(p)).toContainText('Everything is deployed', { timeout: MINUTE });

    expect(remoteFile('index.html')).toBe(INDEX_V2.trim());
    expect(remoteExists('js/app.js')).toBe(false);
    expect(remoteFile('server-only.txt')).toBe(SERVER_ONLY.trim());
    expect(remoteExists('.claude')).toBe(false);
    expect(remoteExists('.claude/settings.json')).toBe(false);
  });

  test('asks about a file changed on the server: Skip keeps it, Overwrite sends ours', async () => {
    test.setTimeout(6 * MINUTE);
    const p = page();
    const serverCss = 'body { color: red; } /* changed on the server, and longer */';
    const localCss = 'body { color: blue; }\n';
    const indexV3 = '<!doctype html><title>v3</title>\n';
    serverExec(ssh(), 'printf "%s" "$2" > "$1"', { args: [`${REMOTE}/css/site.css`, serverCss] });
    writeLocal('css/site.css', localCss);
    writeLocal('index.html', indexV3);

    const card = changesCard(p);
    await expect(card).toContainText('2 changes', { timeout: MINUTE });
    await card.getByRole('button', { name: /^Deploy 2 changes/ }).click();

    const review = p.getByRole('region', { name: 'Review before deploying' });
    const conflicts = review.getByRole('region', { name: 'Conflicts' });
    await expect(conflicts).toContainText('1 file changed on the server', {
      timeout: SERVER_TIMEOUT,
    });
    await expect(conflicts).toContainText('css/site.css');
    await expect(conflicts).toContainText('Changed on the server since your last deploy.');
    const continueButton = review.getByRole('button', { name: 'Continue', exact: true });
    await expect(continueButton).toBeDisabled();
    const choice = conflicts.getByRole('radiogroup', { name: 'What to do with css/site.css' });
    await choice.getByRole('radio', { name: 'Skip', exact: true }).click();
    await expect(choice.getByRole('radio', { name: 'Skip', exact: true })).toHaveAttribute(
      'aria-checked',
      'true',
    );
    await continueButton.click();

    const result = lastDeploy(p);
    await expect(result).toContainText('Deployed', { timeout: SERVER_TIMEOUT });
    await expect(result).toContainText('1 uploaded, 1 skipped');
    expect(remoteFile('css/site.css')).toBe(serverCss);
    expect(remoteFile('index.html')).toBe(indexV3.trim());
    // The skipped file waits for the next deploy.
    await expect(card).toContainText('1 change', { timeout: MINUTE });
    await expect(p.getByRole('list', { name: 'Changed files' })).toContainText('css/site.css');

    await card.getByRole('button', { name: /^Deploy 1 change/ }).click();
    await expect(conflicts).toContainText('css/site.css', { timeout: SERVER_TIMEOUT });
    await conflicts
      .getByRole('radiogroup', { name: 'What to do with css/site.css' })
      .getByRole('radio', { name: 'Overwrite', exact: true })
      .click();
    await review.getByRole('button', { name: 'Continue', exact: true }).click();
    await expect(result).toContainText('Deployed', { timeout: SERVER_TIMEOUT });
    await expect(result).toContainText('1 uploaded');
    await expect(result).not.toContainText('skipped');
    expect(remoteFile('css/site.css')).toBe(localCss.trim());
    await expect(changesCard(p)).toContainText('Everything is deployed', { timeout: MINUTE });
  });

  test('Deploy on save sends an edit by itself', async () => {
    test.setTimeout(6 * MINUTE);
    const p = page();
    await openSection('Settings');
    await p
      .getByRole('region', { name: 'Connection', exact: true })
      .getByRole('button', { name: 'Edit', exact: true })
      .click();
    const dialog = p.getByRole('dialog', { name: `Edit ${SITE_LABEL}` });
    await expect(dialog.getByLabel('Password', { exact: true })).toHaveAttribute(
      'placeholder',
      'Saved, leave empty to keep it',
    );
    await dialog.getByRole('switch', { name: 'Deploy on save' }).click();
    await dialog.getByLabel('Quiet time in seconds').fill('2');
    // Only options changed, so no new test is needed.
    const save = dialog.getByRole('button', { name: 'Save changes', exact: true });
    await expect(save).toBeEnabled();
    await save.click();
    await expect(dialog).toBeHidden({ timeout: MINUTE });

    const settingsSwitch = p.getByRole('switch', { name: 'Deploy on save' });
    await expect(settingsSwitch).toBeChecked();
    await expect(p.getByText('Starts 2 seconds after the last change')).toBeVisible();

    const indexV4 = '<!doctype html><title>v4, sent on save</title>\n';
    writeLocal('index.html', indexV4);
    await expect
      .poll(() => remoteFile('index.html'), { timeout: SERVER_TIMEOUT, intervals: [1000] })
      .toBe(indexV4.trim());

    await openSection('History');
    const deploys = p.getByRole('list', { name: 'Deploys' });
    await p.getByRole('button', { name: 'Refresh' }).click();
    const newest = deploys.getByRole('listitem').first();
    await expect(newest).toContainText('Deploy on save', { timeout: MINUTE });
    await expect(newest).toContainText('1 uploaded');

    // Off again, so the project tab's edit waits for a deploy by hand.
    await openSection('Settings');
    await p.getByRole('switch', { name: 'Deploy on save' }).click();
    await expect(p.getByRole('switch', { name: 'Deploy on save' })).not.toBeChecked({
      timeout: MINUTE,
    });
  });

  test("deploys from the project's Deploy tab, with the pending count in its badge", async () => {
    test.setTimeout(5 * MINUTE);
    const p = page();
    await p
      .getByRole('list', { name: 'Attached projects' })
      .getByRole('link', { name: PROJECT_NAME })
      .click();
    await expect.poll(() => p.evaluate(() => window.location.hash)).toMatch(/tab=deploy/);

    const sections = p.getByRole('navigation', { name: 'Project sections' });
    const site = p.getByRole('region', { name: SITE_LABEL, exact: true });
    await expect(site).toBeVisible({ timeout: MINUTE });
    await expect(site).toContainText('SFTP');
    await expect(site.getByRole('link', { name: 'Open in Deploy' })).toBeVisible();
    await expect(changesCard(site)).toContainText('Everything is deployed', { timeout: MINUTE });
    await expect(sections.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible();

    const indexV5 = '<!doctype html><title>v5, from the project</title>\n';
    writeLocal('index.html', indexV5);
    await expect(sections.getByRole('button', { name: /^Deploy\s*1$/ })).toBeVisible({
      timeout: MINUTE,
    });
    const card = changesCard(site);
    await expect(card).toContainText('1 change');
    await site.getByRole('button', { name: 'Show the files (1)' }).click();
    await expect(site.getByRole('list', { name: 'Changed files' })).toContainText('index.html');

    await card.getByRole('button', { name: /^Deploy 1 change/ }).click();
    const result = lastDeploy(site);
    await expect(result).toContainText('Deployed', { timeout: SERVER_TIMEOUT });
    await expect(result).toContainText('1 uploaded');
    expect(remoteFile('index.html')).toBe(indexV5.trim());
    await expect(sections.getByRole('button', { name: 'Deploy', exact: true })).toBeVisible({
      timeout: MINUTE,
    });
  });
});

test.describe('An FTPS site with a self-signed certificate', () => {
  test.describe.configure({ mode: 'serial', retries: 0 });

  const SITE_LABEL = 'FTPS e2e site';
  const PAGE = '<!doctype html><title>over FTPS</title>\n';

  let server: FtpTestServer | undefined;
  let launched: LaunchedApp | undefined;

  test.beforeAll(async () => {
    test.setTimeout(20 * MINUTE);
    server = await startFtpServer();
    launched = await launchApp({ settings: {} });
  });

  test.afterAll(async () => {
    test.setTimeout(2 * MINUTE);
    try {
      await launched?.close();
    } finally {
      server?.stop();
    }
  });

  test('trusts the certificate in Test connection, then deploys a file', async () => {
    test.setTimeout(6 * MINUTE);
    if (!server || !launched) throw new Error('The FTP server or the app did not start');
    const ftp = server;
    const p = launched.page;
    const folder = join(launched.root, 'ftps-site');
    writeUnder(folder, 'index.html', PAGE);
    const remote = `/home/${ftp.user}/ftps-site`;
    ftp.exec('mkdir -p "$1"', { args: [remote] });

    await p.getByRole('link', { name: 'Deploy', exact: true }).click();
    await p.getByRole('button', { name: 'Add an FTP or SFTP site' }).first().click();
    const dialog = p.getByRole('dialog', { name: 'Add an FTP or SFTP site' });
    await fillLogin(dialog, {
      protocol: 'FTPS',
      host: ftp.host,
      port: ftp.ftpsPort,
      username: ftp.user,
      password: ftp.password,
      localFolder: folder,
      remoteRoot: remote,
    });
    await dialog.getByRole('button', { name: 'Test connection' }).click();
    await expect(dialog.getByText("This computer doesn't trust the certificate")).toBeVisible({
      timeout: SERVER_TIMEOUT,
    });
    await expect(dialog.getByText(/The certificate is self-signed/)).toBeVisible();
    const certificate = dialog.getByRole('group', { name: 'Certificate' });
    const fingerprint = (ftp.certFingerprint256.toUpperCase().match(/.{2}/g) ?? []).join(':');
    await expect(certificate).toContainText(fingerprint);
    await expect(certificate).toContainText('runova-e2e-ftp');

    await dialog.getByRole('button', { name: 'Trust this certificate' }).click();
    await expect(testPassed(dialog)).toBeVisible({ timeout: SERVER_TIMEOUT });
    await expect(dialog.getByText('Its certificate is trusted for this site.')).toBeVisible();
    await dialog.getByLabel('Name', { exact: true }).fill(SITE_LABEL);
    await dialog.getByRole('button', { name: 'Add site', exact: true }).click();
    await expect(dialog).toBeHidden({ timeout: MINUTE });

    const row = p
      .getByRole('list', { name: 'FTP and SFTP sites' })
      .getByRole('button', { name: new RegExp(SITE_LABEL) });
    await expect(row).toContainText('FTPS');
    const card = changesCard(p);
    await expect(card).toContainText('1 change', { timeout: MINUTE });
    await card.getByRole('button', { name: /^Deploy 1 change/ }).click();
    const result = lastDeploy(p);
    await expect(result).toContainText('Deployed', { timeout: SERVER_TIMEOUT });
    await expect(result).toContainText('1 uploaded');
    expect(ftp.exec('cat "$1"', { args: [`${remote}/index.html`] })).toBe(PAGE.trim());
  });
});
