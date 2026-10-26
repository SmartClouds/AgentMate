import { readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp, OS_COLOR_SCHEME } from './app';
import { E2E_OUT_DIR } from './paths';

/**
 * The Vault in the real app: a master password, entries saved through the UI, the clipboard
 * cleared by main, locking by hand, by idle time and after wrong guesses, and nothing readable
 * left on disk. Timers are shortened through RUNOVA_VAULT_TEST_TIMERS, which only an
 * unpackaged build honors.
 */

const MASTER = 'violet lantern orbit 42';
const SECRET_PASSWORD = 'S3ntinel-Pa55-e2e-7f3a';
const SECRET_NOTE = 'S3ntinel-note-e2e-91bc';
const SECRET_USER = 'sentinel-user-e2e@example.com';

let launched: LaunchedApp | undefined;
let relaunched: ElectronApplication | undefined;

function useTimers(value: string): void {
  process.env.RUNOVA_VAULT_TEST_TIMERS = value;
}

test.afterEach(async () => {
  if (relaunched) await closeApp(relaunched, launched?.root);
  relaunched = undefined;
  await launched?.close();
  launched = undefined;
  delete process.env.RUNOVA_VAULT_TEST_TIMERS;
});

async function openVault(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Vault' }).click();
}

async function createVault(page: Page): Promise<void> {
  await openVault(page);
  await expect(page.getByRole('heading', { name: 'Create your vault' })).toBeVisible();
  await page.getByLabel('Master password').fill('short');
  await expect(page.getByText('Use at least 10 characters.')).toBeVisible();
  await page.getByLabel('Master password').fill(MASTER);
  await page.getByLabel('Type it again').fill(MASTER);
  await page.getByRole('checkbox', { name: /can't recover/ }).click();
  await page.getByRole('button', { name: 'Create vault' }).click();
  await expect(page.getByText('Your vault is empty')).toBeVisible();
}

async function unlock(page: Page, password = MASTER): Promise<void> {
  await expect(page.getByRole('heading', { name: 'Vault is locked' })).toBeVisible();
  await page.getByLabel('Master password').fill(password);
  await page.getByRole('button', { name: 'Unlock' }).click();
}

async function addLoginThroughUi(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Add your first entry' }).click();
  const dialog = page.getByRole('dialog', { name: 'New entry' });
  await dialog.getByLabel('Title').fill('GitHub');
  await dialog.getByLabel('Username or email').fill(SECRET_USER);
  await dialog.getByRole('button', { name: 'Generate a password' }).click();
  const generated = await page.getByTestId('generated-password').textContent();
  expect(generated).toHaveLength(20);
  await page.getByRole('button', { name: 'Use password' }).click();
  await dialog.getByLabel('Password', { exact: true }).fill(SECRET_PASSWORD);
  await dialog.getByLabel('Website').fill('github.com/login');
  await dialog.getByLabel('Notes').fill(SECRET_NOTE);
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

async function seedEntries(page: Page): Promise<void> {
  await page.evaluate(async () => {
    const vault = (
      window as unknown as { runova: { vault: { save(input: unknown): Promise<unknown> } } }
    ).runova.vault;
    await vault.save({
      type: 'login',
      title: 'GitLab',
      tags: ['work'],
      favorite: false,
      username: 'dev',
      password: 'gl-pass-1234',
      urls: ['gitlab.com'],
    });
    await vault.save({
      type: 'note',
      title: 'Home Wi-Fi',
      tags: [],
      favorite: false,
      notes: 'guest: hello',
    });
  });
}

function clipboardText(app: ElectronApplication): Promise<string> {
  // Async on purpose: a synchronous callback polled in a tight loop can have its result
  // collected before Playwright reads it.
  return app.evaluate(async ({ clipboard }) => clipboard.readText());
}

async function relaunch(current: LaunchedApp): Promise<Page> {
  const exited = new Promise<void>((resolve) =>
    current.app.process().once('exit', () => resolve()),
  );
  await current.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);
  relaunched = await electron.launch({
    ...OS_COLOR_SCHEME,
    args: [
      join(E2E_OUT_DIR, 'main', 'index.mjs'),
      `--user-data-dir=${current.userDataDir}`,
      ...(process.env.RUNOVA_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      RUNOVA_USER_DATA_DIR: current.userDataDir,
      RUNOVA_E2E: '1', // As in launchApp. Without it, firstWindow() is the splash.
    },
  });
  const page = await relaunched.firstWindow();
  await page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  return page;
}

function filesUnder(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((item) => {
    const path = join(dir, item.name);
    return item.isDirectory() ? filesUnder(path) : [path];
  });
}

/** Every file the app wrote, searched for a secret as UTF-8, UTF-16 and base64. */
function filesContaining(dir: string, secret: string): string[] {
  const needles = [
    Buffer.from(secret, 'utf-8'),
    Buffer.from(secret, 'utf16le'),
    Buffer.from(Buffer.from(secret).toString('base64').slice(0, 16)),
  ];
  return filesUnder(dir).filter((file) => {
    try {
      if (statSync(file).size > 64 * 1024 * 1024) return false;
      const bytes = readFileSync(file);
      return needles.some((needle) => bytes.includes(needle));
    } catch {
      return false;
    }
  });
}

test('create a vault, add a login, find it, copy it and lock', async () => {
  useTimers('clipboardMs=2500,autoLockMs=600000');
  launched = await launchApp({});
  const { page, app } = launched;
  await createVault(page);
  await addLoginThroughUi(page);
  await seedEntries(page);

  const list = page.getByRole('listbox', { name: 'Vault entries' });
  await expect(list.getByRole('option')).toHaveCount(3);

  await page.keyboard.press('Control+F');
  await page.keyboard.type('git');
  await expect(list.getByRole('option')).toHaveCount(2);
  // Saving selected the new login, so the arrows move from GitHub.
  await page.keyboard.press('ArrowDown');
  await expect(page.getByRole('region', { name: 'GitLab' })).toBeVisible();
  await page.keyboard.press('ArrowUp');
  const detail = page.getByRole('region', { name: 'GitHub' });
  await expect(detail).toBeVisible();
  await expect(detail).not.toContainText(SECRET_PASSWORD);

  await detail.getByRole('button', { name: 'Show password' }).click();
  await expect(detail).toContainText(SECRET_PASSWORD);

  await detail.getByRole('button', { name: 'Copy password' }).click();
  await expect.poll(() => clipboardText(app)).toBe(SECRET_PASSWORD);
  await expect(page.getByText(/Clears from the clipboard in/)).toBeVisible();
  await expect.poll(() => clipboardText(app), { timeout: 10_000 }).toBe('');
  await expect(page.getByText('Clipboard cleared')).toBeVisible();

  // Something copied after the vault's copy is left alone.
  await detail.getByRole('button', { name: 'Copy username' }).click();
  await app.evaluate(({ clipboard }) => clipboard.writeText('my own text'));
  await page.waitForTimeout(3500);
  expect(await clipboardText(app)).toBe('my own text');

  await page.keyboard.press('Control+L');
  await expect(page.getByRole('heading', { name: 'Vault is locked' })).toBeVisible();
  const text = await page.locator('body').innerText();
  expect(text).not.toContain('GitHub');
  expect(text).not.toContain(SECRET_USER);

  await unlock(page);
  await expect(
    page.getByRole('listbox', { name: 'Vault entries' }).getByRole('option'),
  ).toHaveCount(3);
});

test('locks itself after the idle period', async () => {
  useTimers('autoLockMs=3000');
  launched = await launchApp({});
  const { page } = launched;
  await createVault(page);
  await expect(page.getByRole('heading', { name: 'Vault is locked' })).toBeVisible({
    timeout: 15_000,
  });
  await expect(page.getByText(/without activity/)).toBeVisible();
});

test('slows down wrong passwords, then lets the right one in', async () => {
  useTimers('backoffBaseMs=2000');
  launched = await launchApp({});
  const { page } = launched;
  await createVault(page);
  await page.getByRole('button', { name: 'Lock vault' }).click();

  for (let attempt = 1; attempt <= 3; attempt++) {
    await page.getByLabel('Master password').fill(`wrong guess number ${attempt}`);
    await page.getByRole('button', { name: 'Unlock' }).click();
    await expect(page.getByRole('alert')).toContainText("doesn't match");
  }
  await expect(page.getByText(/Try again in \ds/)).toBeVisible();
  await page.getByLabel('Master password').fill(MASTER);
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeDisabled();
  await expect(page.getByRole('button', { name: 'Unlock' })).toBeEnabled({ timeout: 10_000 });
  await page.getByRole('button', { name: 'Unlock' }).click();
  await expect(page.getByText('Your vault is empty')).toBeVisible();
});

test('entries survive a restart and nothing secret is left readable on disk', async () => {
  launched = await launchApp({});
  const current = launched;
  await createVault(current.page);
  await addLoginThroughUi(current.page);
  await expect(current.page.getByRole('option', { name: /GitHub/ })).toBeVisible();

  const page = await relaunch(current);
  await openVault(page);
  await unlock(page);
  await expect(page.getByRole('option', { name: /GitHub/ })).toBeVisible();
  await relaunched?.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await new Promise((resolve) => setTimeout(resolve, 1500));

  for (const secret of [SECRET_PASSWORD, SECRET_NOTE, SECRET_USER, MASTER]) {
    expect(filesContaining(current.userDataDir, secret)).toEqual([]);
  }
});

test('imports a Bitwarden CSV export', async () => {
  launched = await launchApp({});
  const { page, app, root } = launched;
  const csv = join(root, 'bitwarden_export.csv');
  writeFileSync(
    csv,
    [
      'folder,favorite,type,name,notes,fields,reprompt,login_uri,login_username,login_password,login_totp',
      'Work,1,login,Jira,,,0,https://jira.example.com,me,jira-pass-1,',
      ',,note,Door code,1234,,0,,,,',
      'Personal,0,card,Visa,,,0,,,,',
    ].join('\n'),
  );
  await app.evaluate(({ dialog }, path) => {
    dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
  }, csv);

  await createVault(page);
  await page.getByRole('button', { name: 'Import from CSV' }).click();
  const dialog = page.getByRole('dialog', { name: 'Import passwords' });
  await dialog.getByRole('button', { name: 'Choose CSV file' }).click();
  // Exactly, or the chosen file's own name ("bitwarden_export.csv") matches the format badge too.
  await expect(dialog.getByText('Bitwarden', { exact: true })).toBeVisible();
  await expect(dialog.getByText(/1 row can't be imported/)).toBeVisible();
  await dialog.getByRole('button', { name: 'Import 2 entries' }).click();
  await expect(dialog.getByText('Imported 2 entries')).toBeVisible();
  await dialog.getByRole('button', { name: 'Done' }).click();

  const list = page.getByRole('listbox', { name: 'Vault entries' });
  await expect(list.getByRole('option')).toHaveCount(2);
  await expect(
    list.getByRole('group', { name: 'Favorites' }).getByRole('option', { name: /Jira/ }),
  ).toBeVisible();
});

test('a backup carries the vault, which opens with its own master password after restore', async () => {
  launched = await launchApp({});
  const source = launched;
  const backupPath = join(source.root, 'backup.json');
  await createVault(source.page);
  await addLoginThroughUi(source.page);
  await source.app.evaluate(({ dialog }, path) => {
    dialog.showSaveDialog = async () => ({ canceled: false, filePath: path });
  }, backupPath);
  const exported = await source.page.evaluate(() =>
    (
      window as unknown as {
        runova: { backup: { export(zip: boolean, o: unknown): Promise<{ ok: boolean }> } };
      }
    ).runova.backup.export(false, { includeVault: true }),
  );
  expect(exported.ok).toBe(true);
  expect(readFileSync(backupPath, 'utf-8')).not.toContain(SECRET_PASSWORD);

  const target = await launchApp({});
  try {
    await target.app.evaluate(({ dialog }, path) => {
      dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [path] });
    }, backupPath);
    const restored = await target.page.evaluate(async () => {
      const api = (
        window as unknown as {
          runova: {
            backup: {
              open(): Promise<{ ok: boolean; token?: string; vault?: unknown }>;
              restore(token: string, options: unknown): Promise<{ ok: boolean }>;
            };
          };
        }
      ).runova.backup;
      const opened = await api.open();
      if (!opened.token) return { opened, restored: null };
      return {
        opened,
        restored: await api.restore(opened.token, {
          environmentsPassword: null,
          restoreVault: true,
        }),
      };
    });
    expect(restored.opened.vault).toEqual({ present: true });
    expect(restored.restored?.ok).toBe(true);

    await openVault(target.page);
    await unlock(target.page);
    await expect(target.page.getByRole('option', { name: /GitHub/ })).toBeVisible();
  } finally {
    await target.close();
  }
});
