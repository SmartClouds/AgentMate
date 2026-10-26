import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The Firewall section's safe apply against the DevHost, whose firewall is pretend but whose
 * change sets, guard and 60-second rollback timer are the core's own: a rule is added, applied,
 * counted down and kept over a new connection; another is left alone and rolls back by itself.
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

async function openFirewall(): Promise<Page> {
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
    .getByRole('button', { name: 'Firewall' })
    .click();
  await expect(page.getByText('Firewall on')).toBeVisible({ timeout: 30_000 });
  return page;
}

/** Adds an allow rule for `port`, reviews the exact command and applies it. */
async function applyPort(page: Page, port: number): Promise<void> {
  await page.getByRole('button', { name: 'Add rule' }).click();
  const form = page.getByRole('dialog', { name: 'Add a rule' });
  await form.getByLabel('Ports').fill(String(port));
  await form.getByLabel('Comment').fill('e2e');
  await form.getByRole('button', { name: 'Stage the rule' }).click();
  const staged = page.getByRole('region', { name: 'Staged changes' });
  await expect(staged.getByText(`Add: Allow port ${port} TCP`)).toBeVisible();
  await staged.getByRole('button', { name: 'Review and apply' }).click();

  const review = page.getByRole('dialog', { name: 'Review the firewall change' });
  await expect(review.getByLabel('Commands')).toContainText(String(port), { timeout: 30_000 });
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Keep changes?' })).toBeVisible();
  await expect(page.getByRole('timer')).toHaveAttribute('aria-label', /^\d+ seconds left$/);
}

test('adds a rule, applies it, counts down and keeps it over a new connection', async () => {
  test.setTimeout(180_000);
  const page = await openFirewall();
  await expect(page.getByRole('row', { name: 'Rule 22 Anywhere' })).toBeVisible();

  await applyPort(page, 8080);
  await expect(page.getByRole('row', { name: 'Rule 8080 Anywhere' })).toBeVisible({
    timeout: 15_000,
  });
  await page.getByRole('button', { name: 'Keep changes' }).click();

  await expect(page.getByText('Firewall change kept.')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('timer')).toBeHidden({ timeout: 15_000 });
  const latest = page.getByRole('list', { name: 'Change history' }).getByRole('listitem').first();
  await expect(latest.getByText(/^Kept ·/)).toBeVisible({ timeout: 15_000 });
  await expect(page.getByRole('row', { name: 'Rule 8080 Anywhere' })).toBeVisible();
});

test('rolls a change nobody keeps back by itself when the countdown runs out', async () => {
  test.setTimeout(240_000);
  const page = await openFirewall();

  await applyPort(page, 8081);
  await expect(page.getByRole('row', { name: 'Rule 8081 Anywhere' })).toBeVisible({
    timeout: 15_000,
  });

  // Nobody keeps it: the core's timer puts the old rules back at the deadline.
  await expect(page.getByRole('timer')).toBeHidden({ timeout: 120_000 });
  await expect(
    page.getByText('Nobody kept the firewall change in time, so the old rules are back.'),
  ).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('row', { name: 'Rule 8081 Anywhere' })).toBeHidden({
    timeout: 30_000,
  });
  const latest = page.getByRole('list', { name: 'Change history' }).getByRole('listitem').first();
  await expect(latest.getByText(/Rolled back: nobody kept it in time/)).toBeVisible({
    timeout: 30_000,
  });
});
