import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';
import {
  E2E_CLOUDFLARE_TOKEN,
  type FakeCloudflareServer,
  startFakeCloudflare,
} from './fakeCloudflareServer';

/**
 * Cloudflare and a server together (E14 T6, T7) in the built app: the recorded Cloudflare fake
 * on loopback stands in for api.cloudflare.com, and the DevHost runs the real core with a pretend
 * firewall. The account token is saved, a zone-scoped DNS token is made and sent to the DevHost
 * (which never shows it back), and the DevHost is locked to Cloudflare's ranges with the
 * firewall's own countdown, kept over a new connection.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';

let devHost: DevHost | undefined;
let cloudflare: FakeCloudflareServer | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  devHost = await startDevHost();
  cloudflare = await startFakeCloudflare();
});

test.afterAll(async () => {
  devHost?.stop();
  await cloudflare?.close();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function signIn(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await dialog.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
}

test('sends the DevHost a DNS token and locks it to Cloudflare', async () => {
  test.setTimeout(240_000);
  if (!devHost || !cloudflare) throw new Error('DevHost or the Cloudflare fake did not start');
  launched = await launchApp({
    settings: {},
    env: {
      RUNOVA_DEPLOY_DEV_CORE: String(devHost.port),
      RUNOVA_E2E_CLOUDFLARE_API: cloudflare.base,
    },
  });
  const { page } = launched;
  await signIn(page);

  // The account token, checked against the recorded API.
  await page.getByRole('button', { name: /Cloudflare: domains and DNS/ }).click();
  await page.getByLabel('API token').fill(E2E_CLOUDFLARE_TOKEN);
  await page.getByRole('button', { name: 'Save and check' }).click();
  await expect(
    page.getByRole('button', { name: 'Choose a domain, example.com is open' }),
  ).toBeVisible({ timeout: 30_000 });

  // A DNS token for the zone, made with the account token and sent to the DevHost.
  await page.getByRole('tab', { name: 'Servers' }).click();
  const servers = page.getByRole('list', { name: 'Servers' });
  await expect(servers.getByText('No DNS token for example.com')).toBeVisible({ timeout: 30_000 });
  await servers.getByRole('button', { name: 'Make a DNS token' }).click();
  await expect(servers.getByText(/Holds a DNS token/)).toBeVisible({ timeout: 30_000 });
  const minted = cloudflare.fake.requests.find(
    (request) => request.path === '/user/tokens' && request.method === 'POST',
  );
  expect(minted).toBeTruthy();
  expect(Object.keys(cloudflare.fake.tokens)).toHaveLength(2);

  // The origin lock on the DevHost's firewall, kept from the countdown banner.
  await page
    .getByRole('navigation', { name: 'Servers' })
    .getByRole('button', { name: /DevHost/ })
    .click();
  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Firewall' })
    .click();
  await expect(page.getByText('Off: every address reaches ports 80 and 443')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Lock to Cloudflare' }).click();
  const review = page.getByRole('dialog', { name: /Lock DevHost to Cloudflare/ });
  await expect(review.getByText(/firewall commands/)).toBeVisible({ timeout: 30_000 });
  await review.getByRole('button', { name: 'Lock to Cloudflare' }).click();
  await expect(page.getByRole('button', { name: 'Keep changes' })).toBeVisible({ timeout: 60_000 });
  await page.getByRole('button', { name: 'Keep changes' }).click();
  await expect(page.getByText('On: only Cloudflare reaches ports 80 and 443')).toBeVisible({
    timeout: 60_000,
  });
});
