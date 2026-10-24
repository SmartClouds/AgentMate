import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Monitoring (E22) through the real UI, against a small endpoint in this process that
 * follows the AgentMate Health Protocol the way the setup prompt asks: it keeps only the key's
 * SHA-256, answers 401 with an empty body to anything else, and reports a failing database with
 * its error when told to.
 *
 * The flow: add a target, copy the hash it shows once onto the endpoint, see the target healthy,
 * break the database and see the error and the inbox entry, then rotate the key and see the
 * endpoint turn the old hash's new key down. Along the way it checks the key is not on disk.
 */

const PROJECT = 'Health e2e';

interface FakeEndpoint {
  url: string;
  setHash(hash: string): void;
  setFailing(failing: boolean): void;
  requests(): number;
  close(): Promise<void>;
}

async function startEndpoint(): Promise<FakeEndpoint> {
  let expected = '';
  let failing = false;
  let count = 0;
  const server: Server = createServer((req, res) => {
    count += 1;
    res.setHeader('Cache-Control', 'no-store');
    const header = req.headers.authorization ?? '';
    const presented = header.startsWith('Bearer ')
      ? createHash('sha256').update(header.slice(7), 'utf8').digest('hex')
      : '';
    if (!expected || presented !== expected) {
      res.setHeader('WWW-Authenticate', 'Bearer realm="agentmate-health"');
      res.statusCode = 401;
      res.end();
      return;
    }
    const report = {
      status: failing ? 'fail' : 'pass',
      releaseId: '1.0.0+e2e',
      checks: {
        'postgres:connection': [
          failing
            ? {
                componentType: 'datastore',
                status: 'fail',
                output: 'connect ECONNREFUSED 10.0.0.5:5432',
                agentmate: { errorCode: 'ECONNREFUSED', hint: 'Start the database container' },
              }
            : { componentType: 'datastore', status: 'pass', observedValue: 3, observedUnit: 'ms' },
        ],
        'redis:ping': [{ componentType: 'datastore', status: 'pass' }],
      },
      agentmate: { protocol: 'agentmate-health/1' },
    };
    res.statusCode = failing ? 503 : 200;
    res.setHeader('Content-Type', 'application/health+json');
    res.end(JSON.stringify(report));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}/_agentmate/health`,
    setHash: (hash) => {
      expected = hash;
    },
    setFailing: (value) => {
      failing = value;
    },
    requests: () => count,
    close: () => new Promise((resolve) => server.close(() => resolve())),
  };
}

let launched: LaunchedApp | undefined;
let endpoint: FakeEndpoint | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await endpoint?.close();
  endpoint = undefined;
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

/** The text of a copy row in the one-time key step, read by its heading. */
async function copyRowValue(page: Page, heading: string): Promise<string> {
  const row = page
    .getByRole('dialog')
    .locator('div.space-y-1')
    .filter({ has: page.getByText(heading, { exact: true }) })
    .first();
  return (await row.locator('code').innerText()).trim();
}

async function checkNow(page: Page): Promise<void> {
  await page.getByRole('button', { name: 'Check now' }).click();
}

test('a target goes healthy, shows a failing service, and turns a rotated key down', async () => {
  endpoint = await startEndpoint();
  const server = endpoint;
  launched = await launchApp({});
  const current = launched;
  const { page } = current;

  await createProject(current);
  await page.evaluate(() => {
    location.hash = '#/monitoring';
  });
  await page.reload();

  // First use explains the three steps, starting with having the agent build the endpoint.
  await expect(page.getByRole('list', { name: 'How to start' })).toBeVisible();
  await page.getByRole('button', { name: 'Build with AI' }).click();
  const build = page.getByRole('dialog', { name: 'Build the endpoint with AI' });
  await build.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: PROJECT }).click();
  const prompt = build.getByRole('region', { name: 'Prompt for your agent' });
  await expect(prompt).toContainText(`Add a healthcheck endpoint to ${PROJECT}`);
  await expect(prompt).toContainText('AGENTMATE_HEALTH_TOKEN_SHA256');
  await expect(prompt).not.toContainText(/amh_[A-Za-z0-9_-]{10,}/);
  await build.getByRole('button', { name: 'Close' }).click();
  await expect(build).toBeHidden();

  await page.getByRole('button', { name: 'Add a target' }).click();
  const dialog = page.getByRole('dialog');
  await dialog.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: PROJECT }).click();
  await dialog.getByLabel('Name', { exact: true }).fill('API');
  await dialog.getByLabel('Server', { exact: true }).fill('web-1');
  await dialog.getByLabel('Endpoint URL', { exact: true }).fill(server.url);
  await dialog.getByRole('button', { name: 'Add target' }).click();

  // The key is shown once. The endpoint gets its hash, the way a user sets the server variable.
  await expect(page.getByText('Save this key now')).toBeVisible();
  const hash = await copyRowValue(page, 'SHA-256');
  expect(hash).toMatch(/^[0-9a-f]{64}$/);
  await page.getByRole('button', { name: 'Show key' }).click();
  const key = await copyRowValue(page, 'Key');
  expect(key).toMatch(/^amh_[A-Za-z0-9_-]{43}$/);
  expect(createHash('sha256').update(key, 'utf8').digest('hex')).toBe(hash);
  server.setHash(hash);
  await page.getByRole('button', { name: 'I saved it' }).click();

  // Encrypted at rest: neither the key nor its hash is in the saved targets.
  const saved = readFileSync(join(current.userDataDir, 'data', 'health-targets.json'), 'utf-8');
  expect(saved).not.toContain(key);
  expect(saved).toContain('API');

  await page.getByRole('button', { name: 'Open API' }).click();
  await checkNow(page);
  const panel = page.getByRole('dialog');
  await expect(panel.getByText('Healthy').first()).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByRole('table', { name: 'Services' })).toContainText('postgres:connection');
  await expect(panel.getByRole('table', { name: 'Services' })).toContainText('redis:ping');

  // The database breaks. One failing sample shows the error; a second confirms the incident.
  server.setFailing(true);
  await checkNow(page);
  await expect(panel.getByText('Down').first()).toBeVisible({ timeout: 20_000 });
  await expect(panel.getByText('connect ECONNREFUSED 10.0.0.5:5432').first()).toBeVisible();
  await expect(panel.getByText('Start the database container').first()).toBeVisible();
  await checkNow(page);
  await expect
    .poll(
      () =>
        page.evaluate(async () => {
          const api = (
            window as unknown as {
              agentmat: {
                appNotifications: { list(): Promise<{ kind: string; route?: string }[]> };
              };
            }
          ).agentmat;
          return (await api.appNotifications.list()).filter(
            (item) => item.kind === 'health-failure',
          ).length;
        }),
      { timeout: 30_000 },
    )
    .toBe(1);

  // A new key. The endpoint still holds the old hash, so it turns the new key down.
  server.setFailing(false);
  await panel.getByRole('button', { name: 'More actions' }).click();
  await page.getByRole('menuitem', { name: 'Rotate key' }).click();
  await page.getByRole('button', { name: 'Rotate key' }).click();
  await expect(page.getByText('Save this key now')).toBeVisible();
  const rotatedHash = await copyRowValue(page, 'SHA-256');
  expect(rotatedHash).not.toBe(hash);
  await page.getByRole('button', { name: 'I saved it' }).click();
  await checkNow(page);
  await expect(page.getByText('Key rejected').first()).toBeVisible({ timeout: 20_000 });

  // And once the server has the new hash, it is healthy again.
  // The list behind the panel still says Healthy from the first check, so a page-wide match
  // passed before this check had even reached the server. The panel's header shows this one.
  server.setHash(rotatedHash);
  await checkNow(page);
  await expect.poll(() => server.requests(), { timeout: 20_000 }).toBeGreaterThanOrEqual(5);
  await expect(panel.getByRole('heading', { name: 'API' }).locator('..')).toContainText('Healthy', {
    timeout: 20_000,
  });
});
