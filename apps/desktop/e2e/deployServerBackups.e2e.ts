import { existsSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * Server backups (E28) against the DevHost, which is the real server core with Docker pretended and
 * every destination kept in memory: an Owner sets the secret key, adds a folder, a Telegram account
 * (signed in with the code) and a destination that refuses everything, then a plan that keeps 2.
 * Three runs of the plan leave 2 backups on each destination that works, and the one that refuses
 * fails on its own without stopping the others. A backup made by hand comes down to this computer,
 * encrypted. Restoring onto a real server is covered by serverBackups.int.test.ts.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'agentmate-local-password';
const SECRET = 'violet harbor lantern pebble';

let devHost: DevHost | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  devHost = await startDevHost();
});

test.afterAll(() => {
  devHost?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Answers the step-up dialog when the core asks for one, or returns once `done` is on screen. */
async function stepUpIfAsked(page: Page, done: Locator): Promise<void> {
  const proof = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(proof.or(done).first()).toBeVisible({ timeout: 30_000 });
  if (await proof.isVisible()) {
    await proof.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await proof.getByRole('button', { name: 'Confirm' }).click();
  }
}

async function addFolder(page: Page, name: string): Promise<void> {
  await page.getByRole('button', { name: 'Add a destination' }).click();
  const dialog = page.getByRole('dialog', { name: 'Add a destination' });
  await dialog.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Folder on the server' }).click();
  await dialog.getByLabel('Name', { exact: true }).fill(name);
  await dialog.getByLabel('Folder', { exact: true }).fill(`/var/backups/${name.toLowerCase()}`);
  await dialog.getByRole('button', { name: 'Save' }).click();
  const row = page.getByRole('listitem', { name });
  await stepUpIfAsked(page, row);
  await expect(row).toBeVisible({ timeout: 30_000 });
}

test('sets up backups, keeps 2 of 3 on each destination, and downloads one encrypted', async () => {
  test.setTimeout(300_000);
  if (!devHost) throw new Error('The DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { AGENTMATE_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page, app, root } = launched;
  const download = join(root, 'devhost.ambackup');
  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, download);

  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Backups' })
    .click();

  // Nothing can be made before there is a secret key, and the overview leads there.
  await expect(page.getByText(/No secret key yet/)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Back up now' })).toBeDisabled();
  await page.getByRole('button', { name: 'Set the secret key' }).click();
  await expect(page.getByText(/never stored on the server/)).toBeVisible();
  await page.getByLabel('New secret key', { exact: true }).fill(SECRET);
  await page.getByLabel('New secret key again', { exact: true }).fill(SECRET);
  await page.getByRole('button', { name: 'Set the secret key' }).click();
  const change = page.getByRole('button', { name: 'Change the secret key' });
  await stepUpIfAsked(page, change);
  await expect(change).toBeVisible({ timeout: 30_000 });

  // A folder, a Telegram account and a destination that refuses everything.
  await page.getByRole('tab', { name: 'Destinations' }).click();
  await addFolder(page, 'Disk');
  await addFolder(page, 'Offline box');
  await page.getByRole('button', { name: 'Add a destination' }).click();
  const telegram = page.getByRole('dialog', { name: 'Add a destination' });
  await telegram.getByRole('combobox', { name: 'Kind' }).click();
  await page.getByRole('option', { name: 'Telegram' }).click();
  await expect(telegram.getByText(/parts of 2000 MB/)).toBeVisible();
  await telegram.getByLabel('Name', { exact: true }).fill('Telegram');
  await telegram.getByLabel('api_id', { exact: true }).fill('12345');
  await telegram.getByLabel('api_hash', { exact: true }).fill('0123456789abcdef0123456789abcdef');
  await telegram.getByLabel('Phone number', { exact: true }).fill('+10000000001');
  await telegram.getByRole('button', { name: 'Send the code' }).click();
  const code = telegram.getByLabel('Code from Telegram', { exact: true });
  await stepUpIfAsked(page, code);
  await code.fill('54321');
  await telegram.getByRole('button', { name: 'Continue' }).click();
  await expect(telegram.getByText(/PHONE_CODE_INVALID|code is wrong/i)).toBeVisible({
    timeout: 30_000,
  });
  await code.fill('12345');
  await telegram.getByRole('button', { name: 'Continue' }).click();
  await expect(telegram.getByText(/Signed in as Ada Lovelace/)).toBeVisible({ timeout: 30_000 });
  await telegram.getByRole('button', { name: 'Save' }).click();
  const telegramRow = page.getByRole('listitem', { name: 'Telegram' });
  await stepUpIfAsked(page, telegramRow);
  await expect(telegramRow).toBeVisible({ timeout: 30_000 });

  // A plan keeping 2, with its preview.
  await page.getByRole('tab', { name: 'Plans' }).click();
  await page.getByRole('button', { name: 'New plan' }).click();
  const planDialog = page.getByRole('dialog', { name: 'New backup plan' });
  await planDialog.getByLabel('Name', { exact: true }).fill('Nightly');
  for (const name of ['Disk', 'Telegram', 'Offline box']) {
    await planDialog.getByRole('checkbox', { name }).click();
  }
  await planDialog.getByLabel('Keep the last', { exact: true }).fill('2');
  await expect(planDialog.getByRole('list', { name: 'Next runs' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(planDialog.getByText(/copied while the apps keep running/)).toBeVisible();
  await planDialog.getByRole('button', { name: 'Save the plan' }).click();
  const plan = page.getByRole('listitem', { name: 'Nightly' });
  await stepUpIfAsked(page, plan);
  await expect(plan.getByText(/Keeps the last 2, on/)).toBeVisible({ timeout: 30_000 });
  for (const name of ['Disk', 'Telegram', 'Offline box']) {
    await expect(plan.getByText(new RegExp(`on .*\\b${name}\\b`))).toBeVisible();
  }
  await expect(plan.getByText(/Next run/)).toBeVisible();

  // Three runs. The others take every backup while the refusing destination waits to try again
  // (30 seconds, then 5 minutes, before it counts as failed; the core's tests cover the end).
  const history = page.getByRole('table', { name: 'Backup runs' });
  for (let round = 1; round <= 3; round++) {
    await page.getByRole('tab', { name: 'Plans' }).click();
    await plan.getByRole('button', { name: 'Run now' }).click();
    await page.getByRole('tab', { name: 'Overview' }).click();
    await expect(history.getByRole('row')).toHaveCount(round + 1, { timeout: 60_000 });
    const newest = history.getByRole('row').nth(1);
    await expect(newest.getByText(/Disk: Uploaded/)).toBeVisible({ timeout: 60_000 });
    await expect(newest.getByText(/Telegram: Uploaded/)).toBeVisible({ timeout: 60_000 });
    await expect(newest.getByText(/Offline box: Retrying/)).toBeVisible({ timeout: 60_000 });
  }
  await expect(
    history
      .getByRole('row')
      .nth(1)
      .getByText(/Disk: Uploaded, 1 old removed/),
  ).toBeVisible();

  // Two kept on each destination that works.
  await page.getByRole('tab', { name: 'Backups', exact: true }).click();
  for (const name of ['Disk', 'Telegram']) {
    await page.getByRole('combobox', { name: 'Destination' }).click();
    await page.getByRole('option', { name, exact: true }).click();
    const table = page.getByRole('table', { name: `Backups on ${name}` });
    await expect(table.getByRole('row')).toHaveCount(3, { timeout: 30_000 });
    await expect(table.getByText('Nightly')).toHaveCount(2);
  }

  // A backup by hand, straight to this computer.
  await page.getByRole('tab', { name: 'Overview' }).click();
  await page.getByRole('button', { name: 'Back up now' }).click();
  const now = page.getByRole('dialog', { name: /Back up .* now/ });
  await now.getByRole('checkbox', { name: 'Download to this computer' }).click();
  await now.getByRole('button', { name: 'Start the backup' }).click();
  const done = now.getByText(/The backup is done/);
  await stepUpIfAsked(page, done);
  await expect(done).toBeVisible({ timeout: 120_000 });
  await expect(now.getByText(download)).toBeVisible({ timeout: 60_000 });
  expect(existsSync(download)).toBe(true);
  expect(statSync(download).size).toBeGreaterThan(1_000);
  // Encrypted: the pretend volume's text and the database's header never show.
  const bytes = readFileSync(download);
  expect(bytes.includes('volume on the DevHost')).toBe(false);
  expect(bytes.includes('SQLite format 3')).toBe(false);
});
