import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, test } from '@playwright/test';
import { createProject, type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * Private registries (E08) against the DevHost: a sign-in for its pretend private registry is
 * added under Apps > Registries, then an app whose image only pulls with that sign-in deploys.
 * The review says which sign-in goes along, and the token never shows on screen.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';
/** The DevHost's pretend private registry (DevHost.cs). */
const REGISTRY = 'registry.runova.test';
const REGISTRY_USER = 'devhost';
const REGISTRY_TOKEN = 'devhost-registry-token-4417';

const COMPOSE = `services:
  web:
    image: ${REGISTRY}/team/private-web:1.0
    restart: unless-stopped
    environment:
      GREETING: \${GREETING}
    ports:
      - "8080:80"
    healthcheck:
      test: ["CMD", "true"]
`;

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

test('adds a registry sign-in and deploys an app from a private image', async () => {
  test.setTimeout(240_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page, projectDir } = launched;
  writeFileSync(join(projectDir, 'compose.yaml'), COMPOSE);
  const projectId = await createProject(launched);
  await page.evaluate(async (id) => {
    const api = (
      window as unknown as {
        runova: {
          environments: {
            save(input: unknown): Promise<{ id: string }>;
            saveFile(input: unknown): Promise<unknown>;
          };
        };
      }
    ).runova.environments;
    const environment = await api.save({ projectId: id, name: 'Production', kind: 'production' });
    await api.saveFile({
      environmentId: environment.id,
      fileName: '.env',
      content: 'GREETING="hello from a private image"\n',
    });
  }, projectId);
  await page.reload();

  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();

  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name: 'Apps' })
    .click();
  await expect(page.getByText('No apps on this server yet')).toBeVisible({ timeout: 30_000 });

  // Registries: a custom registry's sign-in on this computer.
  await page.getByRole('button', { name: 'Registries' }).click();
  await expect(page.getByText(/No sign-ins yet/)).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: /Custom registry/ }).click();
  const dialog = page.getByRole('dialog', { name: /Custom registry/ });
  await dialog.getByLabel('Registry host').fill(REGISTRY);
  await dialog.getByLabel('User name').fill(REGISTRY_USER);
  await dialog.getByLabel('Access token or password').fill(REGISTRY_TOKEN);
  await dialog.getByRole('button', { name: /Save sign-in/ }).click();
  const saved = page
    .getByRole('list', { name: 'Sign-ins on this computer' })
    .getByRole('listitem', { name: REGISTRY });
  await expect(saved).toBeVisible();
  await expect(saved).toContainText(REGISTRY_USER);
  await expect(page.getByText(REGISTRY_TOKEN)).toHaveCount(0);
  await page
    .getByRole('region', { name: 'Registries' })
    .getByRole('button', { name: 'Apps' })
    .click();

  // The New App wizard, its review naming the sign-in that goes with the deploy.
  await page.getByRole('button', { name: 'New app' }).click();
  await page.getByRole('combobox', { name: 'Project', exact: true }).click();
  await page.getByRole('option', { name: 'e2e project' }).click();
  await page.getByRole('radio', { name: /compose\.yaml/ }).check();
  await page.getByRole('combobox', { name: 'Environment', exact: true }).click();
  await page.getByRole('option', { name: /^Production/ }).click();
  await page.getByLabel('App name').fill('private-site');
  await expect(page.getByRole('list', { name: 'New app steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('list', { name: 'Env keys' }).getByText('GREETING')).toBeVisible({
    timeout: 30_000,
  });
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('list', { name: 'Exposure' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  const plan = page.getByRole('list', { name: 'Registries this app pulls from' });
  await expect(plan.getByRole('listitem', { name: REGISTRY })).toContainText(
    /from this computer goes with the deploy/,
    { timeout: 30_000 },
  );
  await page.getByRole('button', { name: 'Deploy private-site' }).click();

  // The pull signs in, the app goes live, and the token is nowhere on screen.
  const steps = page.getByRole('list', { name: 'Deploy steps' });
  await expect(steps).toBeVisible({ timeout: 60_000 });
  await expect(page.getByText('Revision 1 is live.')).toBeVisible({ timeout: 90_000 });
  await expect(page.getByText(REGISTRY_TOKEN)).toHaveCount(0);
});
