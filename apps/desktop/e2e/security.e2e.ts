import { existsSync, mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The Security center (E15) against the DevHost, whose sshd is pretend but whose checklist, SSH
 * change sets, rollback and backups are the core's own: the checklist scores the server, the SSH
 * fix shows the exact file and the key-login proof, applies after a step-up, and is kept over a
 * new connection; a backup is encrypted on the core and saved where the dialog says.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';
const PASSPHRASE = 'orange tractor bicycle lamp';

let devHost: DevHost | undefined;
let launched: LaunchedApp | undefined;
let folder: string | undefined;

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
  if (folder) rmSync(folder, { recursive: true, force: true });
  folder = undefined;
});

async function openSecurity(): Promise<{ page: Page; app: LaunchedApp['app'] }> {
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await dialog.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Security' })
    .click();
  return { page, app: launched.app };
}

async function confirmStepUp(page: Page): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(dialog).toBeVisible({ timeout: 15_000 });
  await dialog.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await dialog.getByRole('button', { name: 'Confirm' }).click();
}

async function stepUp(page: Page): Promise<void> {
  await confirmStepUp(page);
  await expect(page.getByRole('dialog', { name: 'Confirm it is you' })).toBeHidden();
}

test('scores the server, previews the SSH fix and keeps it over a new connection', async () => {
  test.setTimeout(180_000);
  const { page } = await openSecurity();

  const list = page.getByRole('list', { name: 'Checklist' });
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('img', { name: /^Score \d+ out of 100/ })).toBeVisible();
  await expect(
    list.getByRole('listitem', { name: 'SSH password login off: Needs fixing' }),
  ).toBeVisible();
  await expect(list.getByRole('listitem', { name: 'Firewall on: Done' })).toBeVisible();

  await list.getByRole('button', { name: 'Turn off passwords' }).click();
  const review = page.getByRole('dialog', { name: 'SSH password login off' });
  await expect(review.getByLabel('File contents')).toContainText('PasswordAuthentication no', {
    timeout: 30_000,
  });
  await expect(review.getByLabel('File contents')).toContainText('KbdInteractiveAuthentication no');
  await expect(review.getByRole('list', { name: 'Commands' })).toContainText(
    'systemctl reload ssh',
  );
  await expect(review.getByText(/Key login proven/)).toBeVisible();
  await review.getByRole('button', { name: 'Apply' }).click();
  await stepUp(page);

  await expect(page.getByRole('heading', { name: 'Keep the SSH change?' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('timer')).toHaveAttribute('aria-label', /^\d+ seconds left$/);
  await page.getByRole('button', { name: 'Keep the change' }).click();
  await expect(page.getByRole('heading', { name: 'Keep the SSH change?' })).toBeHidden({
    timeout: 30_000,
  });
  await expect(list.getByRole('listitem', { name: 'SSH password login off: Done' })).toBeVisible({
    timeout: 30_000,
  });

  // The trail records the change and its confirmation.
  await page.getByRole('tab', { name: 'Audit trail' }).click();
  await expect(page.getByRole('cell', { name: 'ssh.confirm' }).first()).toBeVisible({
    timeout: 30_000,
  });
});

test('saves an encrypted backup where the dialog says', async () => {
  test.setTimeout(180_000);
  folder = mkdtempSync(join(tmpdir(), 'runova-e2e-backup-'));
  const path = join(folder, 'devhost.ambackup');
  const { page, app } = await openSecurity();
  await app.evaluate(({ dialog }, target) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: target });
  }, path);

  await page.getByRole('tab', { name: 'Backups' }).click();
  await expect(page.getByRole('button', { name: 'Restore a backup' })).toBeDisabled();
  await page.getByRole('button', { name: 'Back up now' }).click();
  const dialog = page.getByRole('dialog', { name: 'Back up DevHost' });
  await dialog.getByLabel('Passphrase', { exact: true }).fill('short');
  await expect(dialog.getByText('Use at least 12 characters.')).toBeVisible();
  await dialog.getByLabel('Passphrase', { exact: true }).fill(PASSPHRASE);
  await dialog.getByLabel('Passphrase again').fill(PASSPHRASE);
  await dialog.getByRole('button', { name: 'Choose where to save' }).click();
  // Making a backup takes a fresh step-up, unless the last one still counts.
  const asked = page.getByRole('dialog', { name: 'Confirm it is you' });
  const saved = page.getByText(`Backup saved to ${path}`);
  await expect(asked.or(saved)).toBeVisible({ timeout: 60_000 });
  // The confirmation is not waited on to close: its exit animation can outlast the few seconds the
  // "saved" toast stays up, and the toast would be gone before it was looked for.
  if (await asked.isVisible()) await confirmStepUp(page);

  await expect(saved).toBeVisible({ timeout: 60_000 });
  expect(existsSync(path)).toBe(true);
  const bytes = readFileSync(path);
  expect(bytes.subarray(0, 8).toString('latin1')).toBe('AMBACKUP');
  expect(bytes.includes(Buffer.from('runova-local-password'))).toBe(false);
  expect(existsSync(`${path}.partial`)).toBe(false);
});
