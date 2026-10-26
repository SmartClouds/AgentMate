import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';

/**
 * Backup and restore from the Settings screen, end to end: a real file is written, checked as an
 * envelope, and read back after the data it holds has been deleted. Both native dialogs are
 * stubbed in the main process, because those are the only steps a test cannot click.
 *
 * The encrypted environments section gets its own pass: a backup password that does not open the
 * file has to be reported and nothing restored, and the restore then has to go through without
 * the environments.
 */

const BACKUP_PASSWORD = 'e2e-backup-password';

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

interface Envelope {
  version: number;
  exportedAt: string;
  appVersion: string;
  data: {
    projects?: { id: string; name: string }[];
    settings?: Record<string, unknown>;
    projectEnvironments?: Record<string, unknown>;
  };
}

interface ProjectsApi {
  runova: {
    projects: {
      delete(id: string): Promise<void>;
      list(): Promise<{ id: string; name: string }[]>;
    };
  };
}

function projectNames(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const projects = await (window as unknown as ProjectsApi).runova.projects.list();
    return projects.map((project) => project.name);
  });
}

async function openBackupSettings(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/settings?tab=data';
  });
  await expect(page.getByRole('heading', { name: 'Backup & restore' })).toBeVisible();
}

/** Walks the restore flow from the button to the "Backup restored" confirmation. */
async function restoreFromBackup(page: Page): Promise<void> {
  await page.getByRole('button', { name: /^Restore from backup/ }).click();
  const ask = page.getByRole('dialog', { name: 'Restore from backup?' });
  await expect(ask).toBeVisible();
  await ask.getByRole('button', { name: 'Choose backup file…' }).click();
}

/** Answers the restart offer with "Later", so the app under test stays where it is. */
async function declineRestart(page: Page): Promise<void> {
  const done = page.getByRole('dialog', { name: 'Backup restored' });
  await expect(done).toBeVisible({ timeout: 60_000 });
  await done.getByRole('button', { name: 'Later' }).click();
  await expect(done).toBeHidden();
}

test('a backup is written, and restores a project that was deleted after it', async () => {
  launched = await launchApp({ settings: { theme: 'dark' } });
  const current = launched;
  const { page, app, root } = current;
  const backupPath = join(root, 'runova-backup.json');
  const projectId = await createProject(current);

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, backupPath);

  await openBackupSettings(page);
  await page.getByRole('button', { name: 'Export backup' }).click();
  await expect(page.getByText(`Backup saved to ${backupPath}`)).toBeVisible({ timeout: 60_000 });

  expect(existsSync(backupPath)).toBe(true);
  const envelope = JSON.parse(readFileSync(backupPath, 'utf-8')) as Envelope;
  expect(envelope.version).toBe(1);
  expect(envelope.exportedAt).toMatch(/^\d{4}-\d{2}-\d{2}T/);
  expect(envelope.appVersion).toBeTruthy();
  expect(envelope.data.projects?.map((project) => project.name)).toEqual(['e2e project']);
  expect(envelope.data.settings?.theme).toBe('dark');
  // No password was given, so the environments section stays on this machine.
  expect(envelope.data.projectEnvironments).toBeUndefined();

  await page.evaluate(
    (id) => (window as unknown as ProjectsApi).runova.projects.delete(id),
    projectId,
  );
  await expect.poll(() => projectNames(page)).toEqual([]);

  await restoreFromBackup(page);
  await declineRestart(page);

  // The project is back, with the id it had, read from the file rather than from a cache.
  await expect.poll(() => projectNames(page), { timeout: 60_000 }).toEqual(['e2e project']);
  const restored = await page.evaluate(() =>
    (window as unknown as ProjectsApi).runova.projects.list(),
  );
  expect(restored[0].id).toBe(projectId);
});

test('a wrong backup password is refused, and the rest still restores', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page, app, root } = current;
  const backupPath = join(root, 'sealed-backup.json');
  await createProject(current);

  await app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, backupPath);

  await openBackupSettings(page);
  await page.getByRole('switch', { name: 'Include project environments' }).click();
  // The export is held back until the two boxes agree and are long enough.
  await page.getByPlaceholder('Backup password').fill('short');
  await expect(page.getByText('Use at least 8 characters.')).toBeVisible();
  await page.getByPlaceholder('Backup password').fill(BACKUP_PASSWORD);
  await page.getByPlaceholder('Confirm password').fill('something else');
  await expect(page.getByText('The passwords do not match.')).toBeVisible();
  await expect(page.getByRole('button', { name: 'Export backup' })).toBeDisabled();

  await page.getByPlaceholder('Confirm password').fill(BACKUP_PASSWORD);
  await page.getByRole('button', { name: 'Export backup' }).click();
  await expect(page.getByText(`Backup saved to ${backupPath}`)).toBeVisible({ timeout: 60_000 });

  const envelope = JSON.parse(readFileSync(backupPath, 'utf-8')) as Envelope;
  // The section is there and is sealed, so its contents are not readable from the file.
  expect(envelope.data.projectEnvironments?.kdf).toBe('scrypt');
  expect(readFileSync(backupPath, 'utf-8')).not.toContain(BACKUP_PASSWORD);

  await restoreFromBackup(page);
  const passwordDialog = page.getByRole('dialog', { name: 'Backup password' });
  await expect(passwordDialog).toBeVisible({ timeout: 60_000 });

  await passwordDialog.getByLabel('Password', { exact: true }).fill('not-the-password');
  // The dialog also has a "Restore without them" button, so this one is matched exactly.
  await passwordDialog.getByRole('button', { name: 'Restore', exact: true }).click();
  await expect(passwordDialog.getByText('That password does not open this backup.')).toBeVisible({
    timeout: 60_000,
  });
  // Nothing was written, so the dialog is still there to ask again.
  await expect(passwordDialog).toBeVisible();

  await passwordDialog.getByRole('button', { name: 'Restore without them' }).click();
  await expect(passwordDialog).toBeHidden({ timeout: 60_000 });
  await declineRestart(page);
  await expect.poll(() => projectNames(page), { timeout: 60_000 }).toEqual(['e2e project']);
});

test('a file that is not a backup is reported instead of restoring anything', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page, app, root } = current;
  const notABackup = join(root, 'not-a-backup.json');
  await createProject(current);

  writeFileSync(notABackup, JSON.stringify({ hello: 'world' }));
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, notABackup);

  await openBackupSettings(page);
  await restoreFromBackup(page);
  // The envelope check reports the version it could not read, rather than a generic message.
  await expect(page.getByText(/unsupported format|not a valid Runova backup/)).toBeVisible({
    timeout: 60_000,
  });
  await expect(page.getByRole('dialog', { name: 'Backup restored' })).toHaveCount(0);
  expect(await projectNames(page)).toEqual(['e2e project']);
});
