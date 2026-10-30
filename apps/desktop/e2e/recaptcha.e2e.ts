import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import {
  E2E_GOOGLE_EMAIL,
  E2E_GOOGLE_REFRESH_TOKEN,
  E2E_LEGACY_SECRET,
  type FakeGoogleServer,
  startFakeGoogle,
} from './fakeGoogleServer';

/**
 * The reCAPTCHA page in the built app, against a Google fake on loopback (E40): sign in with
 * Google through the real loopback OAuth flow, let Runova make a project and turn reCAPTCHA on,
 * make a key for a typed domain, read its secret, edit it and delete it. Afterwards no file in
 * the profile holds the refresh token in clear.
 */

let launched: LaunchedApp | undefined;
let google: FakeGoogleServer | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await google?.close();
  google = undefined;
});

function filesContaining(dir: string, needle: string): string[] {
  const utf8 = Buffer.from(needle, 'utf-8');
  const utf16 = Buffer.from(needle, 'utf16le');
  const found: string[] = [];
  const walk = (current: string) => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      try {
        const info = statSync(full);
        if (info.isDirectory()) walk(full);
        else if (info.size < 50 * 1024 * 1024) {
          const bytes = readFileSync(full);
          if (bytes.includes(utf8) || bytes.includes(utf16)) found.push(full);
        }
      } catch {
        // Chromium keeps some of its files open exclusively; those are not ours to read.
      }
    }
  };
  walk(dir);
  return found;
}

test('signs in with Google, makes a project and manages a key', async () => {
  google = await startFakeGoogle();
  launched = await launchApp({ settings: {}, env: { RUNOVA_E2E_GOOGLE_API: google.base } });
  const { page, app } = launched;

  // Nothing really opens a browser: the main process follows the consent page itself, which the
  // fake answers by sending it straight back to the app's loopback listener.
  await app.evaluate(({ shell }) => {
    shell.openExternal = async (url: string) => {
      await fetch(url);
    };
  });

  await page.getByRole('link', { name: 'Deploy' }).click();
  await page.getByRole('button', { name: 'Get reCAPTCHA keys' }).click();
  await expect(page.getByRole('heading', { name: 'Stop bots on your sites' })).toBeVisible();

  await page.getByRole('button', { name: 'Sign in with Google' }).click();
  await expect(page.getByRole('heading', { name: 'Choose a Google Cloud project' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(
    page.getByRole('button', { name: `Google account ${E2E_GOOGLE_EMAIL}` }),
  ).toContainText('No project yet');

  await page.getByRole('button', { name: /Create a project for me/ }).click();
  await expect(page.getByText('No keys yet')).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Create your first key' }).click();
  const dialog = page.getByRole('dialog', { name: 'New reCAPTCHA key' });
  await dialog.getByLabel('Name').fill('E2E shop');
  await dialog.getByRole('textbox', { name: 'Domains' }).fill('https://shop.example.com/cart');
  await dialog.getByRole('textbox', { name: 'Domains' }).press('Enter');
  await dialog.getByRole('button', { name: 'Create key' }).click();

  const ready = page.getByRole('dialog', { name: 'Your key is ready' });
  await expect(ready).toBeVisible();
  await expect(ready.getByText(/6LcE2eKey\d{4}/).first()).toBeVisible();
  await ready.getByRole('button', { name: 'Show secret' }).click();
  await expect(ready.getByText(E2E_LEGACY_SECRET)).toBeVisible();
  await ready.getByRole('button', { name: 'Done' }).click();

  const row = page.getByRole('listitem', { name: 'E2E shop' });
  await expect(row).toBeVisible();
  await expect(row.getByText('shop.example.com')).toBeVisible();

  await row.getByRole('button', { name: 'Edit E2E shop' }).click();
  const edit = page.getByRole('dialog', { name: 'Edit E2E shop' });
  await edit.getByRole('textbox', { name: 'Domains' }).fill('www.shop.example.com');
  await edit.getByRole('textbox', { name: 'Domains' }).press('Enter');
  await edit.getByRole('button', { name: 'Save changes' }).click();
  await expect(row.getByText('www.shop.example.com')).toBeVisible();

  await row.getByRole('button', { name: 'Delete E2E shop' }).click();
  await page
    .getByRole('dialog', { name: /Delete the key for E2E shop/ })
    .getByRole('button', { name: 'Delete key' })
    .click();
  await expect(page.getByText('No keys yet')).toBeVisible();

  // A page in Deploy, with the rail marking it, and the sign-in sealed on disk.
  await expect(
    page.getByRole('button', { name: /reCAPTCHA: keys for your sites/ }),
  ).toHaveAttribute('aria-current', 'true');
  expect(filesContaining(launched.userDataDir, E2E_GOOGLE_EMAIL)).toContain(
    join(launched.userDataDir, 'data', 'google-cloud.json'),
  );
  expect(filesContaining(launched.userDataDir, E2E_GOOGLE_REFRESH_TOKEN)).toEqual([]);
});
