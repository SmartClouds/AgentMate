import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The Websites section against a real server core: the DevHost, whose nginx is simulated and
 * whose pretend CA issues in about two seconds. Sets nginx up, adds a site, applies it, issues a
 * certificate and sees the site live with its lock.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';

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

/** Waits for the job dialog's outcome, then closes it. */
async function finishJob(page: Page): Promise<void> {
  const dialog = page
    .getByRole('dialog')
    .filter({ has: page.getByRole('log', { name: 'Job log' }) });
  await expect(dialog.getByRole('status')).toHaveText(/Done/, { timeout: 60_000 });
  await dialog.getByRole('button', { name: 'Close' }).last().click();
  await expect(dialog).toBeHidden();
}

test('sets up nginx, adds a site, applies it and issues a certificate', async () => {
  test.setTimeout(240_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
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
    .getByRole('button', { name: 'Websites' })
    .click();

  // nginx is there but not Runova's yet: set it up.
  const setUp = page.getByRole('button', { name: /Set up nginx for Runova|Install nginx/ });
  await expect(setUp.or(page.getByText('Managed by Runova'))).toBeVisible({ timeout: 30_000 });
  if (await setUp.isVisible()) {
    await setUp.click();
    await finishJob(page);
  }
  await expect(page.getByText('Managed by Runova')).toBeVisible({ timeout: 30_000 });

  // A new site on a port of this server.
  await page.getByRole('button', { name: /Add a site/ }).click();
  await page.getByRole('textbox', { name: 'Domain 1' }).fill('shop.example.com');
  await page.getByRole('tab', { name: 'Proxy' }).click();
  await page.getByLabel('Service name').fill('shop');
  await page.getByLabel('Port').fill('3000');
  await page.getByRole('switch', { name: 'WebSockets' }).click();
  await page.getByRole('button', { name: /Save the site/ }).click();
  await expect(page.getByRole('tab', { name: 'SSL', selected: true })).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByRole('switch', { name: 'Force HTTPS' })).toBeDisabled();

  // Saved is not live: apply it.
  const bar = page.getByRole('region', { name: 'Apply changes' });
  await expect(bar.getByText(/Saved changes are waiting/)).toBeVisible({ timeout: 30_000 });
  await bar.getByRole('button', { name: /Apply changes/ }).click();
  await expect(bar).toBeHidden({ timeout: 60_000 });

  // A certificate from the pretend CA.
  await page.getByRole('button', { name: 'Issue a certificate' }).click();
  const order = page.getByRole('dialog', { name: 'Issue a certificate' });
  await order.getByRole('checkbox').click();
  await order.getByRole('button', { name: 'Issue the certificate' }).click();
  await finishJob(page);
  await expect(page.getByText(/SSL, (89|90) days/).first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('switch', { name: 'Force HTTPS' })).toBeEnabled();

  // Back on the list, the route shows the lock and the site is live.
  await page.getByRole('button', { name: /All sites/ }).click();
  const row = page
    .getByRole('list', { name: 'Sites' })
    .getByRole('listitem', { name: 'shop.example.com' });
  await expect(row.getByText(/^SSL, (89|90) days$/)).toBeVisible({ timeout: 30_000 });
  await expect(row.getByText('websocket')).toBeVisible();
  await expect(row.getByText('shop:3000')).toBeVisible();
  await expect(row.getByText('Live')).toBeVisible({ timeout: 30_000 });
});
