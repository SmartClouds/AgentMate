import { readdirSync, readFileSync, statSync } from 'node:fs';
import { request } from 'node:http';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';
import { type FakeTelegramApi, startFakeTelegramApi } from './fakeTelegramApi';

/**
 * Telegram alerts (E30) against the DevHost, which is the real server core: an Owner opens the
 * server's Notifications section, gives it a bot token, a group's chat ID and a server name, and the
 * core starts sending with no restart. A test message reaches a fake Bot API on loopback with the
 * token in the address and the chat and name that were chosen. Then a container on the DevHost
 * crashes three times: the core's own watcher raises a crash loop alert and the notifier sends it,
 * with nothing in the app involved. The token never shows on screen or on this computer's disk. A
 * refusing Telegram says why, and removing puts it back to not set up.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'agentmate-local-password';
const SECRET = 'AAHe2eQx9v2Lw8YtPz5rNc4mBq7sDf1gHjE';
const TOKEN = `7700000001:${SECRET}`;
const CHAT = '-1001234567890';
const CRASHING = 'shop-worker-1';

let devHost: DevHost | undefined;
let telegram: FakeTelegramApi | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(async () => {
  test.setTimeout(300_000);
  telegram = await startFakeTelegramApi();
  devHost = await startDevHost({
    args: [`--Core:Telegram:ApiBase=http://127.0.0.1:${telegram.port}/`],
  });
});

test.afterAll(async () => {
  devHost?.stop();
  await telegram?.stop();
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

/** Makes one of the DevHost's pretend containers exit and restart, as a crash loop does. */
function crash(port: number, container: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const call = request(
      {
        host: '127.0.0.1',
        port,
        method: 'POST',
        path: '/dev/containers/crash',
        headers: { host: 'agentmate-core', 'content-type': 'application/json' },
      },
      (response) => {
        response.resume();
        if (response.statusCode === 204) resolve();
        else reject(new Error(`The DevHost answered ${response.statusCode} to a crash.`));
      },
    );
    call.once('error', reject);
    call.end(JSON.stringify({ container, exitCode: 1 }));
  });
}

/** Every file under a folder that holds the text. Chromium keeps some locked; those hold nothing of ours. */
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

test('sets Telegram alerts up, sends a test and a crash loop to the chat, and removes them', async () => {
  test.setTimeout(240_000);
  if (!devHost || !telegram) throw new Error('The DevHost or the fake Telegram did not start');
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
    .getByRole('button', { name: 'Notifications' })
    .click();

  // Not set up: the steps and the form, every alert on.
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByText(/@BotFather/)).toBeVisible();
  await expect(page.getByRole('switch', { name: 'Backup failed' })).toBeChecked();
  await expect(page.getByRole('switch', { name: 'Container keeps restarting' })).toBeChecked();

  await page.getByLabel('Server name', { exact: true }).fill('e2e-box');
  await page.getByLabel('Bot token', { exact: true }).fill(TOKEN);
  await page.getByLabel('Chat ID', { exact: true }).fill(CHAT);
  await page.getByRole('button', { name: 'Turn on Telegram alerts' }).click();
  const waiting = page.getByText('On, nothing sent yet', { exact: true });
  await stepUpIfAsked(page, waiting);
  await expect(waiting).toBeVisible({ timeout: 30_000 });

  // The core holds the setup, and the form let go of the token.
  const details = page.getByLabel('Telegram details');
  await expect(details.getByText(CHAT, { exact: true })).toBeVisible();
  await expect(details.getByText('e2e-box', { exact: true })).toBeVisible();
  await expect(details.getByText('Every alert', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Bot token', { exact: true })).toHaveValue('');

  // A test message reaches the chat, from the bot, named after the server.
  await page.getByRole('button', { name: 'Send test message' }).click();
  await expect(page.getByText(/Telegram took the test message/)).toBeVisible({ timeout: 60_000 });
  const tested = telegram.messages.find((message) => message.text.includes('AgentMate test'));
  expect(tested?.path).toBe(`/bot${TOKEN}/sendMessage`);
  expect(tested?.chatId).toBe(CHAT);
  expect(tested?.text).toContain('AgentMate test from e2e-box');

  // A container that keeps crashing reaches the chat from the core alone.
  for (let round = 0; round < 3; round++) await crash(devHost.port, CRASHING);
  await expect
    .poll(
      () =>
        telegram?.messages.some((message) => message.text.includes(`${CRASHING} keeps restarting`)),
      {
        timeout: 30_000,
      },
    )
    .toBe(true);
  const loop = telegram.messages.find((message) => message.text.includes('keeps restarting'));
  expect(loop?.text).toMatch(/^🔴 Critical on e2e-box: A container keeps restarting\n/);
  expect(loop?.chatId).toBe(CHAT);

  // The token is on neither the screen nor this computer's disk.
  await expect(page.getByText(SECRET)).toHaveCount(0);
  expect(filesContaining(launched.userDataDir, SECRET)).toEqual([]);

  // A Telegram that refuses says why.
  telegram.refuse({ status: 400, description: 'Bad Request: chat not found' });
  await page.getByRole('button', { name: 'Send test message' }).click();
  await expect(page.getByText(/Telegram cannot find that chat/).first()).toBeVisible({
    timeout: 60_000,
  });
  telegram.refuse(null);

  // Removing asks first, then forgets the token.
  await page.getByRole('button', { name: 'Remove', exact: true }).click();
  const confirm = page.getByRole('dialog', { name: /^Stop sending alerts from / });
  await confirm.getByRole('button', { name: 'Remove', exact: true }).click();
  await stepUpIfAsked(page, page.getByText('Not set up', { exact: true }));
  await expect(page.getByText('Not set up', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByLabel('Bot token', { exact: true })).toBeVisible();
});
