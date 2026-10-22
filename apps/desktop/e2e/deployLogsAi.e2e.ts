import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';
import { type FakeOllama, startFakeOllama } from './fakeOllama';

/**
 * The Logs section and the Deploy AI against a real server core (E09): the DevHost's pretend
 * Docker has a sender that keeps crashing, so the problems feed shows a crash loop. "Diagnose
 * with AI" opens the drawer on it; with auto-run diagnostics on, the scripted model's read-only
 * check runs at once, and its next command, which is not on the allowlist, waits for approval
 * until the user runs it. That restart brings the sender back, and the crash loop leaves the
 * feed. The model is a fake Ollama, as in the SSH AI's spec. Visual states are
 * checked through the DOM.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

/** The DevHost's fixed development owner (see its DevHost.cs). */
const DEV_PASSWORD = 'agentmate-local-password';
const CRASHING = 'newsletter-sender-1';

let devHost: DevHost | undefined;
let ollama: FakeOllama | undefined;
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
  await ollama?.close();
  ollama = undefined;
});

test('a crash loop, diagnosed: a check runs by itself, a change waits for approval', async () => {
  test.setTimeout(240_000);
  if (!devHost) throw new Error('DevHost did not start');
  ollama = await startFakeOllama([
    `RUN: docker logs --tail 50 ${CRASHING}`,
    `RUN: docker restart ${CRASHING}`,
    'FINISHED: The sender cannot reach its SMTP relay; restarted it.',
  ]);
  launched = await launchApp({
    settings: {
      promptBuilderProvider: 'ollama',
      ollamaModel: 'e2e-script',
      ollamaBaseUrl: ollama.url,
    },
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
    .getByRole('button', { name: 'Logs' })
    .click();

  // The problems feed names the crash loop, in words.
  const problems = page.getByRole('list', { name: 'Problems' });
  const crash = problems.getByRole('listitem', { name: `${CRASHING} keeps restarting` });
  await expect(crash).toBeVisible({ timeout: 30_000 });
  await expect(crash.getByText('Critical')).toBeVisible();
  await expect(crash.getByText('Crash loop')).toBeVisible();

  await crash.getByRole('button', { name: 'Diagnose with AI' }).click();
  const drawer = page.getByRole('complementary', { name: 'Deploy AI' });
  await expect(drawer.getByLabel('Context')).toContainText(
    `Crash loop: ${CRASHING} keeps restarting`,
  );
  await expect(drawer.getByRole('radio', { name: /Approve every command/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  // Auto-run diagnostics takes a step-up.
  await drawer.getByRole('radio', { name: /Auto-run diagnostics/ }).click();
  const confirm = page.getByRole('dialog', { name: /Confirm it is you/ });
  await confirm.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await confirm.getByRole('button', { name: 'Confirm' }).click();
  await expect(drawer.getByRole('radio', { name: /Auto-run diagnostics/ })).toHaveAttribute(
    'aria-checked',
    'true',
  );

  await drawer.getByRole('button', { name: 'Start' }).click();

  // The read-only check ran without asking, and its output is in the timeline as text.
  const check = drawer.getByRole('listitem', {
    name: `Step 1: docker logs --tail 50 ${CRASHING}`,
  });
  await expect(check.getByLabel('Status')).toHaveText('Done', { timeout: 60_000 });
  await expect(check.getByLabel('Output of step 1')).toContainText('ECONNREFUSED');

  // The change is not on the allowlist: the core refused it unsigned, so it waits for the user.
  const approval = drawer.getByRole('group', { name: 'Approve the command' });
  await expect(approval).toContainText(`docker restart ${CRASHING}`, { timeout: 60_000 });
  await expect(approval).toContainText('read-only checks');
  await expect(page.getByRole('button', { name: /Deploy AI, waiting for you/ })).toHaveCount(0);
  await approval.getByRole('button', { name: 'Run it' }).click();

  const change = drawer.getByRole('listitem', {
    name: `Step 2: docker restart ${CRASHING}`,
  });
  await expect(change.getByLabel('Output of step 2')).toContainText(CRASHING, { timeout: 60_000 });
  await expect(drawer.getByText(/Finished: The sender cannot reach its SMTP relay/)).toBeVisible({
    timeout: 60_000,
  });

  // The sender runs again, so the feed drops the crash loop on its next look (every 30 seconds).
  await expect(crash).toHaveCount(0, { timeout: 75_000 });

  // The log entered the prompt as untrusted data, after the rules.
  const first = ollama.prompts[0] ?? '';
  expect(first).toContain(`BEGIN UNTRUSTED DATA (the log of ${CRASHING})`);
  expect(first.indexOf('Rules:')).toBeLessThan(first.indexOf('BEGIN UNTRUSTED DATA'));
});
