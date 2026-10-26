import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * The App Store (E12) and "make private" (E13) against the DevHost. Redis is installed from the
 * catalog through the install sheet, its deploy runs as a timeline and the post-install card
 * shows the connection string masked. Then an app from a project that publishes a port on all
 * addresses shows in the Firewall's exposure view, and "make private" redeploys it with the port
 * on 127.0.0.1. The DevHost's docker compose is simulated on its pretend engine.
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

async function signIn(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await dialog.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();
}

const section = (page: Page, name: string) =>
  page.getByRole('navigation', { name: 'Server sections' }).getByRole('button', { name });

test('installs Redis from the App Store and shows how to connect', async () => {
  test.setTimeout(240_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;
  await signIn(page);
  await section(page, 'App Store').click();

  const catalog = page.getByRole('region', { name: 'Catalog' });
  await expect(catalog.getByRole('listitem', { name: 'Redis' })).toBeVisible({ timeout: 30_000 });
  await catalog.getByRole('button', { name: 'Install Redis' }).click();

  const sheet = page.getByRole('dialog', { name: 'Install Redis' });
  await expect(sheet.getByText('Docker Official Image')).toBeVisible();
  await sheet.getByLabel('App name').fill('e2e-cache');
  await sheet.getByLabel('Port').fill('16390');
  const password = await sheet.getByRole('textbox', { name: /Password/ }).inputValue();
  expect(password).toMatch(/^[A-Za-z0-9]{32}$/);
  await sheet.getByRole('button', { name: 'Install Redis' }).click();

  // The deploy, step by step, then the card.
  const steps = page.getByRole('list', { name: 'Deploy steps' });
  await expect(steps).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Revision 1 is live.')).toBeVisible({ timeout: 90_000 });
  const details = page.getByRole('list', { name: 'Connection details' });
  await expect(details.getByText('redis://:********@127.0.0.1:16390/0')).toBeVisible({
    timeout: 30_000,
  });
  await expect(page.getByText(password)).toHaveCount(0);
  await page.getByRole('button', { name: 'Show passwords' }).click();
  await expect(details.getByText(`redis://:${password}@127.0.0.1:16390/0`)).toBeVisible();

  // Back in the store it is listed as installed.
  await page.getByRole('button', { name: 'App Store' }).first().click();
  const installed = page.getByRole('region', { name: 'Installed from the App Store' });
  await expect(installed.getByRole('listitem', { name: 'e2e-cache' })).toBeVisible({
    timeout: 30_000,
  });
});

test('makes a container that publishes on every address private', async () => {
  test.setTimeout(240_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page, projectDir } = launched;
  writeFileSync(
    join(projectDir, 'compose.yaml'),
    `services:
  web:
    image: nginx:1.29
    restart: unless-stopped
    ports:
      - "18080:80"
    healthcheck:
      test: ["CMD", "true"]
`,
  );
  const projectId = await createProject(launched);
  await signIn(page);

  // An app left public on purpose, through the same calls the New App wizard makes.
  const serverId = await page.evaluate(async () => {
    const api = (
      window as unknown as {
        runova: { deploy: { listServers(): Promise<Array<{ id: string }>> } };
      }
    ).runova;
    const [server] = await api.deploy.listServers();
    return server.id;
  });
  await page.evaluate(
    async ({ serverId: server, projectId: project }) => {
      const stacks = (
        window as unknown as {
          runova: {
            deployStacks: {
              preview(input: unknown): Promise<{ requiresAcknowledgment: string[] }>;
              create(
                input: unknown,
              ): Promise<{ stack: { id: string }; revision: { number: number } }>;
              deploy(input: unknown): Promise<unknown>;
            };
          };
        }
      ).runova.deployStacks;
      const source = { projectId: project, composePath: 'compose.yaml', environmentId: null };
      const preview = await stacks.preview({ ...source, proxiedServices: [] });
      const created = await stacks.create({
        ...source,
        serverId: server,
        name: 'e2e-public',
        proxiedServices: [],
        acknowledgedRisks: preview.requiresAcknowledgment,
      });
      await stacks.deploy({
        serverId: server,
        stackId: created.stack.id,
        revision: created.revision.number,
      });
    },
    { serverId, projectId },
  );

  await section(page, 'Firewall').click();
  await expect(page.getByText('Firewall on')).toBeVisible({ timeout: 30_000 });
  const ports = page.getByRole('region', { name: 'Container ports' });
  const row = ports.getByRole('listitem', { name: 'e2e-public-web-1' });
  // The deploy finishes on its own; the exposure view is read again until it shows.
  await expect(async () => {
    await page.reload();
    await section(page, 'Firewall').click();
    await expect(row.getByText('0.0.0.0:18080 to 80/tcp')).toBeVisible({ timeout: 5_000 });
  }).toPass({ timeout: 90_000 });

  await row.getByRole('button', { name: 'Make private' }).click();
  const confirm = page.getByRole('dialog', { name: 'Make web private?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Make private' }).click();
  await expect(row.getByText(/Private now: revision 2 of e2e-public is live/)).toBeVisible({
    timeout: 90_000,
  });
  await expect(row.getByText('127.0.0.1:18080 to 80/tcp')).toBeVisible({ timeout: 30_000 });

  // Something Runova did not start gets the change to make instead.
  const grafana = ports.getByRole('listitem', { name: 'monitoring-grafana-1' }).first();
  await grafana.getByRole('button', { name: 'Make private' }).click();
  const outside = page.getByRole('dialog', {
    name: "monitoring-grafana-1 can't be changed from here",
  });
  await expect(outside.getByLabel('Compose change')).toContainText('127.0.0.1:3001:3000');
  await outside.getByRole('button', { name: 'Done' }).click();
});
