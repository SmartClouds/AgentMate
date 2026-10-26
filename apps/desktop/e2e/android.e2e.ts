import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type FakeSdk, fakeSdkEnv, writeFakeAndroidSdk } from './androidSdk';
import { type LaunchedApp, launchApp } from './app';

/**
 * The Android page against a fake SDK: a real tree of real executables that answer from a JSON
 * state file the test rewrites between steps.
 *
 * This runs the actual main-process path (SDK resolution, spawning by absolute path, the argv
 * that goes out) rather than a stubbed bridge, which is where the bugs that matter live. The SDK
 * folder has a space in its name on purpose, so the Windows quoting case is covered every run.
 */

let launched: LaunchedApp | undefined;
let sdkRoot: string | undefined;
let sdk: FakeSdk | undefined;

test.beforeEach(() => {
  sdkRoot = mkdtempSync(join(tmpdir(), 'runova-android-'));
  sdk = writeFakeAndroidSdk(sdkRoot);
});

test.afterEach(async () => {
  // Clearing the device list first tells any fake emulator still running to exit, the same way
  // `adb emu kill` would. Otherwise it outlives the test and hangs the worker teardown.
  sdk?.setState({ devices: [] });
  await launched?.close();
  launched = undefined;
  if (sdkRoot) {
    // A shim that has not noticed yet can still hold the folder for a moment.
    await new Promise((done) => setTimeout(done, 600));
    rmSync(sdkRoot, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
  }
  sdkRoot = undefined;
  sdk = undefined;
});

/** Opens the app with the fake SDK set as the override, and lands on the Android page. */
async function openAndroid(): Promise<LaunchedApp> {
  launched = await launchApp({
    settings: { androidSdkPath: sdk!.root },
    env: fakeSdkEnv(sdkRoot!),
  });
  await launched.page.evaluate(() => {
    window.location.hash = '#/android';
  });
  return launched;
}

test('lists the virtual devices the SDK reports', async () => {
  const { page } = await openAndroid();

  await expect(page.getByText('Pixel_7_API_34').first()).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible();
  // The SDK chip proves detection ran against the fake tools rather than anything real.
  await expect(page.getByText(/platform-tools 35\.0\.1/)).toBeVisible();
});

test('starting an emulator pins the console port and brings the card up', async () => {
  const { page } = await openAndroid();
  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Start' }).click();

  await expect(page.getByText('emulator-5554')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible();
  // -port is what makes the serial knowable before the emulator exists.
  await expect
    .poll(() => sdk!.sawCall('-avd Pixel_7_API_34 -port 5554'), { timeout: 10_000 })
    .toBe(true);
});

test('stopping asks the emulator console first', async () => {
  const { page } = await openAndroid();
  await page.getByRole('button', { name: 'Start' }).click();
  await expect(page.getByRole('button', { name: 'Stop' })).toBeVisible({ timeout: 30_000 });

  await page.getByRole('button', { name: 'Stop' }).click();

  await expect(page.getByRole('button', { name: 'Start' })).toBeVisible({ timeout: 30_000 });
  await expect
    .poll(() => sdk!.sawCall('-s emulator-5554 emu kill'), { timeout: 10_000 })
    .toBe(true);
});

test('a connected phone shows up alongside the emulators', async () => {
  const { page } = await openAndroid();
  await expect(page.getByText('Pixel_7_API_34').first()).toBeVisible({ timeout: 30_000 });

  sdk!.setState({
    devices: [{ serial: 'R58M20ABCDE', state: 'device', model: 'Galaxy A52' }],
    props: { R58M20ABCDE: { 'ro.build.version.release': '14', 'ro.build.version.sdk': '34' } },
  });
  await page.getByRole('button', { name: /^Refresh/ }).click();

  await expect(page.getByText('Galaxy A52').first()).toBeVisible({ timeout: 30_000 });
  // The card's own meta line, which "Physical" alone would not be: that word is also a filter tab.
  await expect(page.getByText('Android 14 · API 34 · USB')).toBeVisible();
});

test('an unauthorized phone explains itself instead of offering actions', async () => {
  const { page } = await openAndroid();
  await expect(page.getByText('Pixel_7_API_34').first()).toBeVisible({ timeout: 30_000 });

  sdk!.setState({ devices: [{ serial: '2B141FDH2000XX', state: 'unauthorized' }] });
  await page.getByRole('button', { name: /^Refresh/ }).click();

  await expect(page.getByText(/Allow USB debugging/i)).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Screenshot' })).toHaveCount(0);
});

test('creating a device normalizes the name and calls avdmanager', async () => {
  const { page } = await openAndroid();
  await expect(page.getByRole('button', { name: 'New device' })).toBeEnabled({ timeout: 30_000 });

  await page.getByRole('button', { name: 'New device' }).click();
  await page.getByLabel('Name').fill('My Test Phone');
  // avdmanager rejects spaces, so the dialog says what it will really be saved as.
  await expect(page.getByText('My_Test_Phone')).toBeVisible();
  await page.getByRole('button', { name: 'Create' }).click();

  // The call log is the proof avdmanager actually ran, rather than the dialog's own hint.
  await expect
    .poll(() => sdk!.sawCall('create avd -n My_Test_Phone'), { timeout: 30_000 })
    .toBe(true);
  await expect(page.getByRole('dialog')).toHaveCount(0);
});

test('the page says the SDK is missing when the override points nowhere', async () => {
  launched = await launchApp({
    settings: { androidSdkPath: join(sdkRoot!, 'not-an-sdk') },
    env: fakeSdkEnv(sdkRoot!),
  });
  await launched.page.evaluate(() => {
    window.location.hash = '#/android';
  });

  await expect(launched.page.getByText(/isn't an Android SDK/i)).toBeVisible({ timeout: 30_000 });
  // The probed path is shown, which is what turns a dead end into a fix.
  await expect(launched.page.getByText(/not-an-sdk/)).toBeVisible();
});
