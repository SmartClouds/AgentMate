import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import {
  E2E_CLOUDFLARE_TOKEN,
  type FakeCloudflareServer,
  startFakeCloudflare,
} from './fakeCloudflareServer';

/**
 * Turnstile in the built app (E43): the recorded Cloudflare fake on loopback stands in for
 * api.cloudflare.com. A widget is made from the zone's own tab, its site key, secret and code are
 * shown at once, its secret is rotated, and it is deleted again.
 */

let cloudflare: FakeCloudflareServer | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  cloudflare = await startFakeCloudflare();
});

test.afterAll(async () => {
  await cloudflare?.close();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

test('makes, rotates and deletes a Turnstile widget from the zone', async () => {
  if (!cloudflare) throw new Error('The Cloudflare fake did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_E2E_CLOUDFLARE_API: cloudflare.base },
  });
  const { page } = launched;

  await page.getByRole('link', { name: 'Deploy' }).click();
  await page.getByRole('button', { name: 'Manage Cloudflare' }).click();
  await page.getByLabel('API token').fill(E2E_CLOUDFLARE_TOKEN);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(
    page.getByRole('button', { name: 'Choose a domain, example.com is open' }),
  ).toBeVisible({ timeout: 30_000 });

  // The first widget starts from the domain.
  await page.getByRole('tab', { name: 'Turnstile' }).click();
  await expect(page.getByText('No Turnstile widgets yet')).toBeVisible();
  await page.getByRole('button', { name: 'Add a widget for example.com' }).click();
  const dialog = page.getByRole('dialog');
  await expect(dialog.getByRole('textbox', { name: 'Name' })).toHaveValue('example.com');
  await dialog.getByText('Invisible', { exact: true }).click();
  await dialog.getByRole('button', { name: 'Create widget' }).click();

  // Its site key, secret and code, right away.
  await expect(dialog.getByRole('heading', { name: 'Your widget is ready' })).toBeVisible();
  const [made] = cloudflare.fake.widgets.values().next().value ?? [];
  if (!made) throw new Error('No widget was made');
  await expect(dialog.getByText(String(made.sitekey), { exact: true })).toBeVisible();
  await dialog.getByRole('button', { name: 'Show secret' }).click();
  await expect(dialog.getByText(String(made.secret), { exact: true })).toBeVisible();
  await expect(dialog.getByTestId('snippet')).toContainText(`data-sitekey="${made.sitekey}"`);
  await dialog.getByRole('button', { name: 'Done' }).click();

  // A new secret, with the old one kept for two hours.
  const row = page.getByRole('listitem', { name: 'example.com' });
  await expect(row.getByText('Invisible')).toBeVisible();
  await row.getByRole('button', { name: 'Rotate the secret of example.com' }).click();
  const rotate = page.getByRole('dialog', { name: 'Rotate the secret of example.com' });
  await rotate.getByRole('button', { name: 'Rotate secret' }).click();
  await rotate.getByRole('button', { name: 'Show secret' }).click();
  await expect(rotate.getByText(/rotated/)).toBeVisible();
  const rotation = cloudflare.fake.requests.find((request) =>
    request.path.endsWith('/rotate_secret'),
  );
  expect(rotation?.body).toEqual({ invalidate_immediately: false });
  await rotate.getByRole('button', { name: 'Done' }).click();

  // And gone again, once confirmed.
  await row.getByRole('button', { name: 'Delete example.com' }).click();
  await page
    .getByRole('dialog', { name: /Delete the example.com widget/ })
    .getByRole('button', { name: 'Delete widget' })
    .click();
  await expect(page.getByText('No Turnstile widgets yet')).toBeVisible();
  expect([...cloudflare.fake.widgets.values()].flat()).toEqual([]);
});
