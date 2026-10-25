import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { createDevSetupSandbox, type DevSetupSandbox } from './devSetupSandbox';

/**
 * Agent Tools > Dev Setup, against a private set of fake tools (see devSetupSandbox.ts). Git,
 * Node.js and npm are "installed", the GitHub CLI is not, and `winget` is a script that installs a
 * fake one. Everything is asserted through the page's roles and text, not screenshots.
 *
 * The list has extra rows on a Mac (Homebrew and the Command Line Tools), so that is left out; the
 * install flows drive winget, so they run on Windows only.
 */

test.skip(process.platform === 'darwin', 'macOS adds Homebrew and the Command Line Tools rows');

let launched: LaunchedApp | undefined;
let sandbox: DevSetupSandbox | undefined;

test.beforeEach(async () => {
  sandbox = createDevSetupSandbox();
  launched = await launchApp({ settings: {}, env: sandbox.env() });
});

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  sandbox?.cleanup();
  sandbox = undefined;
});

function required<T>(value: T | undefined): T {
  if (value === undefined) throw new Error('the test did not set up its app');
  return value;
}

async function openDevSetup(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/tools?tab=dev-setup';
  });
  await expect(page.getByRole('heading', { name: 'What do you build?' })).toBeVisible({
    timeout: 30_000,
  });
}

/**
 * The one row with this name. Matched on the name itself, not on any text in the row, because the
 * GitHub sign-in row mentions "GitHub CLI" in its description and would otherwise match too.
 */
function row(page: Page, name: string) {
  return page
    .getByRole('region', { name: 'Essentials' })
    .getByRole('listitem')
    .filter({ has: page.getByText(name, { exact: true }) });
}

test('shows what is installed and what is missing', async () => {
  const { page } = required(launched);
  await openDevSetup(page);

  await expect(page.getByRole('heading', { name: '3 of 4 ready' })).toBeVisible({
    timeout: 30_000,
  });
  await expect(row(page, 'Git')).toContainText('Version 2.55.0');
  await expect(row(page, 'Node.js')).toContainText('Version 22.12.0');
  await expect(row(page, 'npm')).toContainText('Version 10.9.0');
  await expect(row(page, 'GitHub CLI')).toContainText('Not installed. Needs 2.40 or newer.');
  await expect(page.getByRole('button', { name: 'Install GitHub CLI' })).toBeVisible();
});

test('can be reached from the Agent Tools navigation', async () => {
  const { page } = required(launched);

  await page.getByRole('link', { name: 'Agent Tools' }).click();
  await page
    .getByRole('navigation', { name: 'Tool categories' })
    .getByRole('button', { name: /^Dev Setup/ })
    .click();

  await expect(page.getByRole('heading', { name: 'What do you build?' })).toBeVisible({
    timeout: 30_000,
  });
  await expect.poll(() => page.evaluate(() => window.location.hash)).toContain('tab=dev-setup');
});

test('remembers the stacks that were chosen, across a reload', async () => {
  const { page } = required(launched);
  await openDevSetup(page);
  await expect(page.getByRole('region', { name: 'Docker' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Docker', exact: true }).click();

  await expect(page.getByRole('region', { name: 'Docker' })).toBeVisible();
  await expect
    .poll(() => required(launched).settingsOnDisk().devSetupStacks)
    .toEqual(['essentials', 'docker']);

  await page.reload();
  await openDevSetup(page);
  await expect(page.getByRole('region', { name: 'Docker' })).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Docker', exact: true })).toHaveAttribute(
    'aria-pressed',
    'true',
  );
});

test.describe('installing, with a fake winget', () => {
  test.skip(process.platform !== 'win32', 'drives a fake winget');

  test('installs the GitHub CLI inside the app and checks the result', async () => {
    const { page } = required(launched);
    await openDevSetup(page);
    await expect(page.getByRole('heading', { name: '3 of 4 ready' })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Install GitHub CLI' }).click();

    await expect(page.getByRole('progressbar', { name: /^GitHub CLI:/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('heading', { name: 'Everything is ready' })).toBeVisible({
      timeout: 60_000,
    });
    await expect(row(page, 'GitHub CLI')).toContainText('Version 2.62.0');
    await expect(
      page.getByText(/Terminals that are already open will not see the new tools/),
    ).toBeVisible();

    // The exact silent command, run for this one package.
    const calls = required(sandbox).wingetCalls();
    expect(calls).toHaveLength(1);
    expect(calls[0]).toBe(
      'install --id GitHub.cli --exact --source winget --silent --accept-package-agreements --accept-source-agreements',
    );
  });

  test('says what went wrong, opens the log, and works on another try', async () => {
    const { page } = required(launched);
    required(sandbox).failNextInstall();
    await openDevSetup(page);
    await expect(page.getByRole('heading', { name: '3 of 4 ready' })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Install GitHub CLI' }).click();

    await expect(row(page, 'GitHub CLI')).toContainText('winget could not finish (code 1603).', {
      timeout: 60_000,
    });
    await expect(page.getByRole('log', { name: 'Log for GitHub CLI' })).toContainText(
      'Installer failed with exit code 1603',
    );

    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(page.getByRole('heading', { name: 'Everything is ready' })).toBeVisible({
      timeout: 60_000,
    });
  });

  test('cancels an install that is under way and goes back to offering it', async () => {
    const { page } = required(launched);
    required(sandbox).makeInstallsSlow();
    await openDevSetup(page);
    await expect(page.getByRole('heading', { name: '3 of 4 ready' })).toBeVisible({
      timeout: 30_000,
    });

    await page.getByRole('button', { name: 'Install GitHub CLI' }).click();
    await expect(page.getByRole('progressbar', { name: /^GitHub CLI:/ })).toBeVisible({
      timeout: 30_000,
    });
    // Exact, because the row's own "Cancel installing GitHub CLI" button also contains this text.
    await page.getByRole('button', { name: 'Cancel install', exact: true }).click();

    await expect(page.getByRole('button', { name: 'Install GitHub CLI' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(page.getByRole('heading', { name: '3 of 4 ready' })).toBeVisible();
    await expect(page.getByRole('heading', { name: 'Everything is ready' })).toHaveCount(0);
  });
});

test.describe('updating, with a fake winget', () => {
  test.skip(process.platform !== 'win32', 'drives a fake winget');

  /** The GitHub CLI is installed at 2.62.0 and winget offers 2.70.0. */
  function offerUpdate(): void {
    const fake = required(sandbox);
    fake.installGh('2.62.0');
    fake.offerGhUpdate();
  }

  test('marks a tool that is behind, keeps it ready, and updates it in the app', async () => {
    const { page } = required(launched);
    offerUpdate();
    await openDevSetup(page);

    // Ready all the same: a newer version is not a missing tool.
    await expect(page.getByRole('heading', { name: 'Everything is ready' })).toBeVisible({
      timeout: 30_000,
    });
    await expect(row(page, 'GitHub CLI')).toContainText('Version 2.62.0');
    await expect(row(page, 'GitHub CLI')).toContainText('2.70.0 available', { timeout: 60_000 });
    await expect(page.getByText(/1 update available\./)).toBeVisible();
    await expect(
      page.getByRole('region', { name: 'Essentials' }).getByText('1 update', { exact: true }),
    ).toBeVisible();

    await page.getByRole('button', { name: 'Update GitHub CLI' }).click();

    await expect(page.getByRole('progressbar', { name: /^GitHub CLI:/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(row(page, 'GitHub CLI')).toContainText('Version 2.70.0', { timeout: 60_000 });
    await expect(row(page, 'GitHub CLI')).not.toContainText('available');
    await expect(page.getByText(/Everything is up to date\./)).toBeVisible({ timeout: 30_000 });
    await expect(
      page.getByText(/Terminals that are already open will not see the new versions/),
    ).toBeVisible();

    // An upgrade, not an install, and for this one package.
    expect(required(sandbox).wingetCalls()).toEqual([
      'upgrade --id GitHub.cli --exact --source winget --silent --accept-package-agreements --accept-source-agreements',
    ]);
  });

  test('asks winget once for the whole list when the page opens', async () => {
    const { page } = required(launched);
    offerUpdate();
    await openDevSetup(page);
    await expect(row(page, 'GitHub CLI')).toContainText('2.70.0 available', { timeout: 60_000 });

    expect(required(sandbox).wingetChecks()).toEqual([
      'upgrade --source winget --accept-source-agreements --disable-interactivity',
    ]);
    // Looking is not changing anything.
    expect(required(sandbox).wingetCalls()).toEqual([]);
  });

  test('updates everything from Update all', async () => {
    const { page } = required(launched);
    offerUpdate();
    await openDevSetup(page);

    // With nothing missing, the one button with work to do is the one on offer.
    await expect(page.getByRole('button', { name: /Install all missing/ })).toHaveCount(0, {
      timeout: 30_000,
    });
    await page.getByRole('button', { name: 'Update all (1)' }).click();

    await expect(page.getByRole('heading', { name: /^Updating 1 of 1: GitHub CLI/ })).toBeVisible({
      timeout: 30_000,
    });
    await expect(row(page, 'GitHub CLI')).toContainText('Version 2.70.0', { timeout: 60_000 });
    await expect(page.getByRole('button', { name: /Update all/ })).toHaveCount(0);
  });

  test('says what went wrong, keeps the tool, and works on another try', async () => {
    const { page } = required(launched);
    offerUpdate();
    required(sandbox).failNextInstall();
    await openDevSetup(page);
    await expect(row(page, 'GitHub CLI')).toContainText('2.70.0 available', { timeout: 60_000 });

    await page.getByRole('button', { name: 'Update GitHub CLI' }).click();

    await expect(row(page, 'GitHub CLI')).toContainText('Update failed.', { timeout: 60_000 });
    await expect(row(page, 'GitHub CLI')).toContainText('winget could not finish (code 1603).');
    // Still the old version, still ready.
    await expect(row(page, 'GitHub CLI')).toContainText('Version 2.62.0');
    await expect(page.getByRole('heading', { name: 'Everything is ready' })).toBeVisible();

    await page.getByRole('button', { name: 'Try again' }).click();

    await expect(row(page, 'GitHub CLI')).toContainText('Version 2.70.0', { timeout: 60_000 });
  });

  test('says so when winget could not say, instead of claiming everything is current', async () => {
    const { page } = required(launched);
    offerUpdate();
    required(sandbox).failUpdateChecks();
    await openDevSetup(page);

    await expect(page.getByText(/Could not check for updates\./)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/Everything is up to date/)).toHaveCount(0);
    await expect(page.getByRole('button', { name: /Update/ })).toHaveCount(0);
  });

  test('shows no updates when nothing is behind', async () => {
    const { page } = required(launched);
    required(sandbox).installGh('2.70.0');
    await openDevSetup(page);

    await expect(page.getByText(/Everything is up to date\./)).toBeVisible({ timeout: 60_000 });
    await expect(page.getByText(/available/)).toHaveCount(0);
  });
});
