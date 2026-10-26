import { createServer } from 'node:net';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * Direct TLS (E16) against the DevHost, which serves the core's real TLS listener on loopback:
 * an Owner turns it on from the Security area, keeps the firewall rule through the safe apply,
 * and the live connection moves to the TLS port with this computer's device key as its client
 * certificate. Turning it off closes the port, takes the rule away and the link goes back.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');
// The listener is TLS 1.3 only, and .NET's SslStream on macOS has not served TLS 1.3. Real cores
// run on Linux, where the core tests and the system test cover it.
test.skip(process.platform === 'darwin', 'the DevHost cannot serve TLS 1.3 on macOS');

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

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

/**
 * Answers the step-up dialog when the core asks for one. The dialog only shows once the first try
 * comes back refused, and isVisible does not wait, so this waits for the dialog or for `done`.
 */
async function stepUpIfAsked(page: Page, done: Locator): Promise<void> {
  const proof = page.getByRole('dialog', { name: 'Confirm it is you' });
  await expect(proof.or(done)).toBeVisible({ timeout: 30_000 });
  if (await proof.isVisible()) {
    await proof.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
    await proof.getByRole('button', { name: 'Confirm' }).click();
  }
}

/** Applies the firewall change set the card offers and keeps it over a new connection. */
async function applyAndKeep(page: Page, port: number): Promise<void> {
  const review = page.getByRole('dialog', { name: 'Review the firewall change' });
  await expect(review.getByLabel('Commands')).toContainText(String(port), { timeout: 30_000 });
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  await expect(review).toBeHidden({ timeout: 30_000 });
  await expect(page.getByRole('heading', { name: 'Keep changes?' })).toBeVisible();
  await page.getByRole('button', { name: 'Keep changes' }).click();
  await expect(page.getByText('Firewall change kept.')).toBeVisible({ timeout: 30_000 });
}

test('turns direct TLS on, connects over it with the device key, and turns it off', async () => {
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
    .getByRole('button', { name: 'Security' })
    .click();
  await page.getByRole('tab', { name: 'Connection' }).click();

  // Off by default, with the pin of the certificate the core made on its first start.
  const details = page.getByLabel('Direct TLS details');
  await expect(details.getByText('Off', { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(details.getByText(/^sha256\/[A-Za-z0-9+/]{43}=$/)).toBeVisible();

  const port = await freePort();
  await page.getByLabel('Port', { exact: true }).fill(String(port));
  await page.getByRole('button', { name: 'Turn on direct TLS' }).click();
  const listening = details.getByText(`On, listening on port ${port}`);
  await stepUpIfAsked(page, listening);
  await expect(listening).toBeVisible({ timeout: 30_000 });
  await applyAndKeep(page, port);

  // The live link starts over on the TLS port: the pill says what it rides on.
  await expect(
    page.getByRole('status', { name: 'Live connection: Connected, direct TLS' }),
  ).toBeVisible({
    timeout: 60_000,
  });
  await expect(details.getByText(/Tries direct TLS first/)).toBeVisible();

  await page.getByRole('button', { name: 'Turn off' }).click();
  await page.getByRole('dialog').getByRole('button', { name: 'Turn off' }).click();
  await expect(details.getByText('Off', { exact: true })).toBeVisible({ timeout: 30_000 });
  await applyAndKeep(page, port);
  await expect(
    page.getByRole('status', { name: 'Live connection: Connected, loopback' }),
  ).toBeVisible({
    timeout: 60_000,
  });
});
