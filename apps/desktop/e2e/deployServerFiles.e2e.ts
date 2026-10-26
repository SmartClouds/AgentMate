import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The Deploy Files section (E27) against a real server core: the DevHost's pretend Docker, whose
 * containers and volumes have file trees of their own. A file goes up into the running `toolbox`
 * container, comes back down to this computer byte for byte, is renamed and deleted. A file goes
 * into the `shop_uploads` volume, opened from the Volumes tab's Browse files button. In the
 * stopped `migrate-once` container the file still lists, but rename and delete are off and the
 * page says why. What the core holds is checked by listing again after a refresh, since the
 * DevHost's Docker lives in its own memory.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

/** The DevHost's fixed development owner (see its DevHost.cs). */
const DEV_PASSWORD = 'runova-local-password';
const UPLOADED = 'e2e-note.txt';
const CONTENT = 'Hello from the E27 e2e test.\nSecond line, with ünïcode.\n';

let devHost: DevHost | undefined;
let launched: LaunchedApp | undefined;
let localRoot = '';

test.beforeAll(async () => {
  test.setTimeout(300_000);
  devHost = await startDevHost();
  localRoot = mkdtempSync(join(tmpdir(), 'runova-e2e-deploy-files-'));
  writeFileSync(join(localRoot, UPLOADED), CONTENT);
});

test.afterAll(() => {
  devHost?.stop();
  if (localRoot) rmSync(localRoot, { recursive: true, force: true });
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

function remotePane(page: Page): Locator {
  return page.getByRole('region', { name: /^Server / });
}

function localPane(page: Page): Locator {
  return page.getByRole('region', { name: 'This computer' });
}

function row(page: Page, side: 'local' | 'remote', name: string): Locator {
  return page.locator(`[data-sftp-grid="${side}"]`).locator(`[data-sftp-row="${name}"]`);
}

/** Types a folder into a pane's path bar and waits for the pane to show it. */
async function goTo(page: Page, side: 'local' | 'remote', path: string, lastCrumb: string) {
  await page.getByTestId(`${side}-path-space`).click();
  const label = side === 'local' ? 'Folder on this computer' : 'Folder on the server';
  const field = page.getByRole('textbox', { name: label });
  // Opening the field fills in the pane's folder a frame later; see sshFiles.e2e.ts.
  await expect(async () => {
    await field.fill(path);
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
  await expect(
    page.getByRole('navigation', { name: label }).locator('[aria-current="location"]'),
  ).toHaveText(lastCrumb);
}

async function pick(page: Page, combobox: string, option: string | RegExp): Promise<void> {
  await page.getByRole('combobox', { name: combobox }).click();
  await page.getByRole('option', { name: option }).click();
}

async function signInAndOpenFiles(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
}

function sections(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Server sections' });
}

async function refresh(page: Page): Promise<void> {
  await remotePane(page).getByRole('button', { name: 'Refresh' }).click();
}

test('moves files in and out of a container and a volume', async () => {
  test.setTimeout(240_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await signInAndOpenFiles(page);

  // 1. The Files section on the DevHost starts on containers (it has no SSH disk to show).
  await sections(page).getByRole('button', { name: 'Files' }).click();
  await expect(page.getByRole('combobox', { name: 'Source' })).toContainText('Container');
  await pick(page, 'Container', /^toolbox/);
  await expect
    .poll(() => page.evaluate(() => location.hash))
    .toMatch(/view=files.*source=container.*target=toolbox|target=toolbox.*source=container/);
  await expect(
    remotePane(page).getByRole('navigation', { name: 'Folder on the server' }),
  ).toBeVisible({ timeout: 30_000 });

  // 2. Up into /tmp of the container.
  await goTo(page, 'local', localRoot, localRoot.split(/[\\/]/).at(-1) ?? '');
  await goTo(page, 'remote', '/tmp', 'tmp');
  await row(page, 'local', UPLOADED).click();
  await localPane(page).getByRole('button', { name: 'Upload to server' }).click();
  await expect(row(page, 'remote', UPLOADED)).toBeVisible({ timeout: 60_000 });
  await refresh(page);
  await expect(row(page, 'remote', UPLOADED)).toBeVisible();

  // 3. Back down under another name: the local copy is gone first, so nothing asks.
  rmSync(join(localRoot, UPLOADED));
  await localPane(page).getByRole('button', { name: 'Refresh' }).click();
  await expect(row(page, 'local', UPLOADED)).toHaveCount(0);
  await row(page, 'remote', UPLOADED).click();
  await remotePane(page).getByRole('button', { name: 'Download to this computer' }).click();
  await expect(row(page, 'local', UPLOADED)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => readFileSync(join(localRoot, UPLOADED), 'utf-8')).toBe(CONTENT);

  // 4. Rename, then delete, in the container.
  await row(page, 'remote', UPLOADED).click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Rename/ }).click();
  const name = page.getByRole('textbox', { name: `New name for ${UPLOADED}` });
  await name.fill('renamed.txt');
  await name.press('Enter');
  await expect(row(page, 'remote', 'renamed.txt')).toBeVisible({ timeout: 30_000 });
  await expect(row(page, 'remote', UPLOADED)).toHaveCount(0);

  await row(page, 'remote', 'renamed.txt').click({ button: 'right' });
  await page.getByRole('menuitem', { name: /^Delete/ }).click();
  const confirm = page.getByRole('dialog', { name: /^Delete "renamed\.txt"/ });
  await confirm.getByRole('button', { name: 'Delete', exact: true }).click();
  await expect(row(page, 'remote', 'renamed.txt')).toHaveCount(0, { timeout: 30_000 });
  await refresh(page);
  await expect(row(page, 'remote', 'renamed.txt')).toHaveCount(0);

  // 5. The Volumes tab opens the same section on a volume, shown from its root.
  await sections(page).getByRole('button', { name: 'Containers' }).click();
  await page.getByRole('tab', { name: 'Volumes' }).click();
  await page
    .getByRole('listitem', { name: 'shop_uploads' })
    .getByRole('button', { name: 'Browse files in shop_uploads' })
    .click();
  await expect.poll(() => page.evaluate(() => location.hash)).toMatch(/source=volume/);
  await expect(page.getByRole('combobox', { name: 'Volume' })).toContainText('shop_uploads');
  await expect(
    remotePane(page)
      .getByRole('navigation', { name: 'Folder on the server' })
      .locator('[aria-current="location"]'),
  ).toBeVisible({ timeout: 30_000 });
  await goTo(page, 'local', localRoot, localRoot.split(/[\\/]/).at(-1) ?? '');
  await row(page, 'local', UPLOADED).click();
  await localPane(page).getByRole('button', { name: 'Upload to server' }).click();
  await expect(row(page, 'remote', UPLOADED)).toBeVisible({ timeout: 60_000 });
  await refresh(page);
  await expect(row(page, 'remote', UPLOADED)).toBeVisible();
});

test('a stopped container lists and copies but cannot rename or delete', async () => {
  test.setTimeout(180_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await signInAndOpenFiles(page);
  await sections(page).getByRole('button', { name: 'Files' }).click();
  await pick(page, 'Container', /^migrate-once/);

  // The reason is on the page, above the server pane.
  await expect(page.getByText(/The container is stopped/).first()).toBeVisible({
    timeout: 30_000,
  });

  // Something to act on: the first row the container lists.
  const first = page.locator('[data-sftp-grid="remote"] [data-sftp-row]').first();
  await expect(first).toBeVisible({ timeout: 30_000 });
  await first.click({ button: 'right' });
  await expect(page.getByRole('menuitem', { name: /^Rename/ })).toBeDisabled();
  await expect(page.getByRole('menuitem', { name: /^Delete/ })).toBeDisabled();
  await page.keyboard.press('Escape');
});
