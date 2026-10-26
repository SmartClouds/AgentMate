import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';
import { type FakeSentryIngest, startFakeSentryIngest } from './fakeSentryIngest';

/**
 * Error reporting (E29) against the DevHost, which is the real server core: an Owner pastes a Sentry
 * DSN in the Security area, the core starts sending its warnings and errors as OpenTelemetry logs
 * with no restart, and a test event reaches a fake Sentry on loopback with the right address, the
 * key as the signature, and the names the Owner chose. The key never shows on screen or on this
 * computer's disk. Pausing stops the test event, and removing puts it back to not set up.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';
const KEY = 'e2e0d4e5f60718293a4b5c6d7e8f90a1';
const PROJECT_ID = '7';

let devHost: DevHost | undefined;
let ingest: FakeSentryIngest | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  devHost = await startDevHost();
  ingest = await startFakeSentryIngest();
});

test.afterAll(async () => {
  devHost?.stop();
  await ingest?.stop();
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

/** Answers the step-up dialog when the core asks for one, or returns once `done` is on screen. */
async function stepUpIfAsked(page: Page, done: Locator): Promise<void> {
  const proof = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(proof.or(done)).toBeVisible({ timeout: 30_000 });
  if (await proof.isVisible()) {
    await proof.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await proof.getByRole('button', { name: 'Confirm' }).click();
  }
}

/**
 * Every file under a folder that holds the text, so a key written in the clear is found. Chromium
 * keeps some of its files locked while the app runs; those cannot hold anything the app wrote.
 */
function filesContaining(root: string, needle: string): string[] {
  const found: string[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      try {
        const info = statSync(path);
        if (info.isDirectory()) walk(path);
        else if (info.size < 20_000_000 && readFileSync(path).includes(needle)) found.push(path);
      } catch {
        // Locked or gone since it was listed.
      }
    }
  };
  walk(root);
  return found;
}

test('sets error reporting up, sends a test event to Sentry, pauses it and removes it', async () => {
  test.setTimeout(240_000);
  if (!devHost || !ingest) throw new Error('The DevHost or the fake Sentry did not start');
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
    .getByRole('button', { name: 'Security' })
    .click();
  await page.getByRole('tab', { name: 'Error reporting' }).click();

  // Not set up: the steps and the form.
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Send test event' })).toHaveCount(0);

  // A good DSN says where logs will go; the key stays in a masked field.
  const dsn = `http://${KEY}@127.0.0.1:${ingest.port}/${PROJECT_ID}`;
  await page.getByLabel('Sentry DSN').fill(dsn);
  await expect(
    page.getByText(`Sends to 127.0.0.1:${ingest.port}, project ${PROJECT_ID}`),
  ).toBeVisible();
  await page.getByRole('button', { name: 'staging', exact: true }).click();
  await page.getByLabel('Server name').fill('e2e-box');
  await page.getByRole('button', { name: 'Turn on error reporting' }).click();
  const waiting = page.getByText('On, nothing sent yet', { exact: true });
  await stepUpIfAsked(page, waiting);
  await expect(waiting).toBeVisible({ timeout: 30_000 });

  // The core now holds the setup, and the form let go of the key.
  const details = page.getByLabel('Error reporting details');
  await expect(details.getByText(`127.0.0.1:${ingest.port}, project ${PROJECT_ID}`)).toBeVisible();
  await expect(details.getByText('staging', { exact: true })).toBeVisible();
  await expect(details.getByText('e2e-box', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Sentry DSN')).toHaveValue('');

  // A test event reaches Sentry, signed with the key, with the names that were chosen.
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(page.getByText(/Sentry accepted the test event/)).toBeVisible({ timeout: 60_000 });
  await expect.poll(() => ingest?.requests.length ?? 0).toBeGreaterThan(0);
  const request = ingest.requests.at(-1);
  expect(request?.method).toBe('POST');
  expect(request?.path).toBe(`/api/${PROJECT_ID}/integration/otlp/v1/logs`);
  expect(request?.headers['x-sentry-auth']).toBe(`sentry sentry_key=${KEY}`);
  expect(request?.headers['content-type']).toContain('application/x-protobuf');
  expect(request?.body).toContain('test event');
  expect(request?.body).toContain('e2e-box');
  expect(request?.body).toContain('staging');
  expect(request?.body).toContain('runova-core');
  await expect(page.getByText('Sending', { exact: true })).toBeVisible({ timeout: 30_000 });

  // The key is on neither the screen nor this computer's disk.
  await expect(page.getByText(KEY)).toHaveCount(0);
  expect(filesContaining(launched.userDataDir, KEY)).toEqual([]);

  // A Sentry that refuses says why, and the card shows the state.
  ingest.answer(401);
  await page.getByRole('button', { name: 'Send test event' }).click();
  await expect(
    page.getByText(/Sentry rejected the key in this DSN \(HTTP 401\)/).first(),
  ).toBeVisible({
    timeout: 60_000,
  });
  ingest.answer(200);

  // Pausing keeps the setup and stops the test.
  await page.getByRole('switch', { name: 'Send logs to Sentry' }).click();
  await page.getByRole('button', { name: 'Save changes' }).click();
  const paused = page.getByText('Paused', { exact: true });
  await stepUpIfAsked(page, paused);
  await expect(paused).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Send test event' })).toBeDisabled();

  // Removing asks first, then forgets the DSN.
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /^Stop reporting errors from / });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await stepUpIfAsked(page, page.getByText('Not set up', { exact: true }));
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Sentry DSN')).toBeVisible();
});
