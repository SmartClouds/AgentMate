import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The Containers section against a real server core (E06 AC5): the DevHost's pretend Docker,
 * with its "shop" and "monitoring" projects, moving stats and a log, reached through the same
 * hub link the app uses for a server over SSH. Visual states are checked through the DOM.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

/** The DevHost's fixed development owner (see its DevHost.cs). */
const DEV_PASSWORD = 'agentmate-local-password';

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

test('lists the shop project and shows a container’s stats and log', async () => {
  test.setTimeout(180_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { AGENTMATE_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Containers' })
    .click();

  // The shop project with its four containers, each state in words.
  const list = page.getByRole('list', { name: 'Containers' });
  await expect(list.getByRole('heading', { name: 'shop' })).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole('heading', { name: 'monitoring' })).toBeVisible();
  const api = list.getByRole('listitem', { name: 'shop-api-1' });
  await expect(api.getByText('Running', { exact: true })).toBeVisible();
  await expect(
    list.getByRole('listitem', { name: 'migrate-once' }).getByText('Exited'),
  ).toBeVisible();
  // Live figures reach the row.
  await expect(api.getByLabel('Processor for shop-api-1')).toHaveText(/\d+(\.\d)?%/, {
    timeout: 30_000,
  });

  await api.getByRole('button', { name: 'Open shop-api-1' }).click();
  const drawer = page.getByRole('dialog', { name: 'shop-api-1' });
  await expect(drawer.getByText('node server.js')).toBeVisible({ timeout: 30_000 });

  await drawer.getByRole('tab', { name: 'Stats' }).click();
  await expect(drawer.getByTestId('stat-Processor')).toHaveText(/\d+(\.\d)?%/, {
    timeout: 30_000,
  });
  await expect(drawer.getByTestId('stat-Memory')).toHaveText(/MB|GB/);

  await drawer.getByRole('tab', { name: 'Logs' }).click();
  const log = drawer.getByRole('log', { name: 'Log of shop-api-1' });
  await expect(log.locator('[data-stream]').first()).toBeVisible({ timeout: 30_000 });
  // The core redacts the secrets the DevHost planted in its logs.
  await expect(log).not.toContainText('pg-secret-7c41d2');
  await expect(log).not.toContainText('tok-live-5f2e9a71c3');

  // Variables by name only, values hidden until an Admin asks.
  await drawer.getByRole('tab', { name: 'Inspect' }).click();
  const variables = drawer.getByRole('list', { name: 'Variables' });
  await expect(variables).toContainText('DATABASE_URL');
  await expect(variables).not.toContainText('postgres://');
});

test('follows a compose project’s logs and runs a command in one of its containers', async () => {
  test.setTimeout(180_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { AGENTMATE_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Containers' })
    .click();

  // Every service of the shop project in one log, each line named by its service.
  const list = page.getByRole('list', { name: 'Containers' });
  await expect(list.getByRole('heading', { name: 'shop' })).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Logs of shop' }).click();
  const sheet = page.getByRole('dialog', { name: 'shop' });
  const log = sheet.getByRole('log', { name: 'Log: shop' });
  await expect(log.locator('[data-level]').first()).toBeVisible({ timeout: 30_000 });
  await expect(log).not.toContainText('pg-secret-7c41d2');

  // A command, as another user, in a terminal.
  await sheet.getByRole('tab', { name: 'Console' }).click();
  await sheet.getByLabel('Command').fill('echo hi');
  await sheet.getByLabel('User').click();
  await page.getByPlaceholder('A user, or uid:gid').fill('nobody');
  await page.getByRole('option', { name: 'Run as nobody' }).click();
  await sheet.getByRole('button', { name: 'Run', exact: true }).click();
  await expect(sheet.getByRole('status')).toContainText('Running echo hi as nobody in');
  await expect(sheet.locator('.terminal-pane .xterm-rows')).toContainText('nobody@', {
    timeout: 30_000,
  });
  await sheet.getByRole('button', { name: 'Close the console' }).click();
  await expect(sheet.getByLabel('Command')).toHaveValue('echo hi');
});
