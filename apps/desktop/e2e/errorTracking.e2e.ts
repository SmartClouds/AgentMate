import { readdirSync, readFileSync, statSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import {
  CRASH,
  type FakeSentryServer,
  LEAK_BEARER,
  LEAK_COOKIE,
  LEAK_EMAIL,
  LEAK_IP,
  LEAK_PASSWORD,
  LEAK_QUERY_TOKEN,
  ORG,
  SENTRY_TOKEN,
  startFakeSentry,
} from './fakeSentryServer';

/**
 * Error tracking (E24) through the real UI, against a fake Sentry on loopback in this process.
 * A self-hosted host is the only one that takes a plain http address, and only on this machine,
 * which is what lets the app reach the fake without any test hook in the main process.
 *
 * The flow: connect with a token, link the project to the Sentry projects it suggests, open an
 * issue and read its stack trace, copy it for an AI and check that what lands on the clipboard
 * has no email, IP, cookie, token or password from the event, resolve it, and hand it to Claude
 * Code. Along the way it checks the token is nowhere on disk in plain text.
 */

const PROJECT = 'Storefront';

let launched: LaunchedApp | undefined;
let sentry: FakeSentryServer | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await sentry?.close();
  sentry = undefined;
});

async function createProject(current: LaunchedApp): Promise<void> {
  await current.page.evaluate(
    async ({ folderPath, name }) => {
      const api = (
        window as unknown as {
          agentmat: { projects: { create(input: unknown): Promise<{ id: string }> } };
        }
      ).agentmat;
      await api.projects.create({
        name,
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: [],
      });
    },
    { folderPath: current.projectDir, name: PROJECT },
  );
}

/** Every file under `dir` that holds `needle`, as UTF-8 or UTF-16. Locked files are skipped. */
function filesContaining(dir: string, needle: string): string[] {
  const utf8 = Buffer.from(needle, 'utf-8');
  const utf16 = Buffer.from(needle, 'utf16le');
  const found: string[] = [];
  const walk = (current: string) => {
    let names: string[];
    try {
      names = readdirSync(current);
    } catch {
      return;
    }
    for (const name of names) {
      const full = join(current, name);
      try {
        const info = statSync(full);
        if (info.isDirectory()) walk(full);
        else if (info.size < 64 * 1024 * 1024) {
          const bytes = readFileSync(full);
          if (bytes.includes(utf8) || bytes.includes(utf16)) found.push(full);
        }
      } catch {
        // Chromium keeps some of its files open exclusively; those are not ours to read.
      }
    }
  };
  walk(dir);
  return found;
}

test('error tracking connects Sentry, shows an issue, copies it redacted, resolves it and hands it to Claude Code', async () => {
  sentry = await startFakeSentry();
  const server = sentry;
  launched = await launchApp({ settings: { defaultCliId: 'claude-code' } });
  const current = launched;
  const { page } = current;

  await createProject(current);
  await page.evaluate(() => {
    location.hash = '#/monitoring?view=errors';
  });
  await page.reload();

  // What the browser hands the system clipboard only lands while the window really has focus,
  // which a test run cannot count on, so this records what the app writes instead.
  await page.evaluate(() => {
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      (window as unknown as { copied?: string[] }).copied = [
        ...((window as unknown as { copied?: string[] }).copied ?? []),
        text,
      ];
      await original(text).catch(() => undefined);
    };
  });

  // First use explains the steps.
  await expect(page.getByText('See what breaks for your users', { exact: true })).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Connect Sentry' }).click();

  // Connect: a self-hosted host on loopback, the token, a check that lists what it can do.
  const dialog = page.getByRole('dialog', { name: 'Error tracking connections' });
  await expect(dialog).toBeVisible();
  await dialog.getByRole('combobox', { name: 'Sentry host', exact: true }).click();
  await page.getByRole('option', { name: 'Self-hosted or GlitchTip' }).click();
  await dialog.getByLabel('Server URL', { exact: true }).fill(server.url);
  await dialog.getByLabel('Auth token', { exact: true }).fill(SENTRY_TOKEN);
  await dialog.getByRole('button', { name: 'Check token' }).click();
  const scopes = dialog.getByRole('list', { name: 'Token scopes' });
  await expect(scopes).toBeVisible({ timeout: 30_000 });
  for (const scope of ['org:read', 'project:read', 'event:read', 'event:write']) {
    await expect(scopes).toContainText(scope);
  }
  await expect(scopes).not.toContainText('Missing');
  // The only organization is picked already.
  await expect(dialog.getByRole('combobox', { name: 'Organization', exact: true })).toContainText(
    ORG.name,
  );
  await dialog.getByRole('button', { name: 'Save connection' }).click();
  await expect(page.getByText(`Connected to ${ORG.name}`)).toBeVisible({ timeout: 30_000 });
  expect(server.requestsTo('/api/0/').length).toBeGreaterThan(0);
  expect(
    server.requests.every((request) => request.authorization === `Bearer ${SENTRY_TOKEN}`),
  ).toBe(true);

  // Link: the project's name picks both storefront projects; billing-worker stays out.
  const linkDialog = page.getByRole('dialog', { name: 'Error tracking connections' });
  await expect(linkDialog.getByRole('region', { name: 'Link projects' })).toBeVisible({
    timeout: 30_000,
  });
  const picker = linkDialog.getByRole('combobox', {
    name: `Sentry projects for ${PROJECT}`,
    exact: true,
  });
  await expect(picker).toContainText('storefront-api', { timeout: 30_000 });
  await expect(picker).toContainText('storefront-web');
  await expect(picker).not.toContainText('Billing Worker');
  await expect(linkDialog.getByText('Suggested from the project name')).toBeVisible();
  await linkDialog.getByRole('button', { name: 'Save links' }).click();
  await expect(page.getByText('Link saved')).toBeVisible({ timeout: 30_000 });
  await linkDialog.getByRole('button', { name: 'Close' }).click();
  await expect(linkDialog).toBeHidden();

  // The list: both issues, grouped under the project.
  const list = page.getByRole('list', { name: 'Issues' });
  await expect(list).toBeVisible({ timeout: 30_000 });
  await expect(list.getByRole('button', { name: CRASH.title, exact: true })).toBeVisible();
  await expect(
    list.getByRole('button', { name: 'Slow checkout render', exact: true }),
  ).toBeVisible();
  const listCall = server.requestsTo(`/api/0/organizations/${ORG.slug}/issues/`, 'GET').at(-1);
  expect(listCall?.url).toContain('query=is%3Aunresolved');

  // The issue up close: the stack trace with the app's own frame on top.
  await list.getByRole('button', { name: CRASH.title, exact: true }).click();
  const detail = page.getByRole('dialog', { name: CRASH.title });
  await expect(detail).toBeVisible({ timeout: 30_000 });
  const trace = detail.getByRole('region', { name: 'Stack trace' });
  await expect(trace).toBeVisible({ timeout: 30_000 });
  await expect(trace.getByTestId('frame').first()).toContainText(CRASH.frame.filename);
  await expect(trace.getByTestId('frame').first()).toContainText(CRASH.frame.function);
  await expect(detail.getByRole('region', { name: 'Breadcrumbs' })).toContainText('[email]');
  await expect(detail).not.toContainText(LEAK_EMAIL);
  await expect(detail).not.toContainText(LEAK_IP);
  await expect(detail).not.toContainText(LEAK_QUERY_TOKEN);
  await expect(detail).not.toContainText(LEAK_BEARER);
  const issueHash = await page.evaluate(() => location.hash);
  expect(issueHash).toContain('issue=');

  // Copy for AI: the error and where it broke, and nothing that identifies a user or a secret.
  await detail.getByRole('button', { name: 'Copy for AI' }).click();
  await expect(page.getByText('Prompt copied')).toBeVisible({ timeout: 30_000 });
  const copied = await page.evaluate(
    () => (window as unknown as { copied?: string[] }).copied ?? [],
  );
  expect(copied).toHaveLength(1);
  const text = copied[0];
  expect(text).toContain(CRASH.error);
  expect(text).toContain(`${CRASH.frame.function} (${CRASH.frame.at})`);
  for (const secret of [
    LEAK_EMAIL,
    LEAK_IP,
    LEAK_COOKIE,
    LEAK_QUERY_TOKEN,
    LEAK_BEARER,
    LEAK_PASSWORD,
    SENTRY_TOKEN,
  ]) {
    expect(text).not.toContain(secret);
  }

  // Resolve: Sentry gets the PUT, the toast offers Undo, and the issue leaves the list.
  await detail.getByRole('button', { name: 'Resolve', exact: true }).click();
  await expect(page.getByText('Issue resolved')).toBeVisible({ timeout: 30_000 });
  await expect(page.getByRole('button', { name: 'Undo' })).toBeVisible();
  const issuePath = `/api/0/organizations/${ORG.slug}/issues/${CRASH.id}/`;
  await expect.poll(() => server.requestsTo(issuePath, 'PUT').length).toBe(1);
  expect(JSON.parse(server.requestsTo(issuePath, 'PUT')[0].body)).toEqual({ status: 'resolved' });
  expect(server.statusOf(CRASH.id)).toBe('resolved');
  await expect(detail.getByRole('button', { name: 'Reopen' })).toBeVisible({ timeout: 30_000 });
  await page.keyboard.press('Escape');
  await expect(detail).toBeHidden();
  await expect(list.getByRole('button', { name: CRASH.title, exact: true })).toHaveCount(0, {
    timeout: 30_000,
  });
  await expect(
    list.getByRole('button', { name: 'Slow checkout render', exact: true }),
  ).toBeVisible();

  // Encrypted at rest: the saved connection is there, the token is not, nor anywhere else.
  const saved = readFileSync(join(current.userDataDir, 'data', 'error-tracking.json'), 'utf-8');
  expect(saved).toContain(ORG.slug);
  expect(saved).not.toContain(SENTRY_TOKEN);
  // The walk does find what is on disk, so an empty answer for the token means something.
  expect(filesContaining(current.userDataDir, server.url)).toContain(
    join(current.userDataDir, 'data', 'error-tracking.json'),
  );
  expect(filesContaining(current.userDataDir, SENTRY_TOKEN)).toEqual([]);

  // Fix with AI: the issue's link still opens it, and the prompt goes to Claude Code.
  await page.evaluate((hash) => {
    location.hash = hash;
  }, issueHash);
  await expect(detail).toBeVisible({ timeout: 30_000 });
  await detail.getByRole('button', { name: 'Fix with AI' }).click();
  const prompt = page.getByLabel('Fix prompt');
  await expect(prompt).toBeVisible({ timeout: 30_000 });
  await expect(prompt).toHaveValue(/Cannot read properties of undefined/, { timeout: 30_000 });
  await expect(prompt).toHaveValue(/computeTotals/);
  await expect(prompt).not.toHaveValue(new RegExp(LEAK_EMAIL.replace(/\./g, '\\.')));
  const before = current.claudeLaunches().length;
  await page
    .getByRole('button', { name: /^(Open in Claude Code|Run on )/ })
    .first()
    .click();
  await expect(prompt).toBeHidden({ timeout: 30_000 });
  // The model sizing runs claude headless (-p); the fix itself opens an interactive tab.
  const interactive = () =>
    current
      .claudeLaunches()
      .slice(before)
      .filter((line) => !/(^|\s)(-p|--print)(\s|$)/.test(line));
  await expect.poll(() => interactive().length, { timeout: 60_000 }).toBeGreaterThan(0);

  // Still nowhere on disk once the app has run an agent with the prompt.
  expect(filesContaining(current.userDataDir, SENTRY_TOKEN)).toEqual([]);
});
