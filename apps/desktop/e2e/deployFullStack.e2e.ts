import { writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import {
  loadImage,
  REGISTRY_HOST,
  REGISTRY_PULLER,
  REGISTRY_TOKEN,
  startPrivateRegistry,
} from '../src/main/deploy/testing/privateRegistry';
import {
  systemTestsEnabled,
  TEST_LOGINS,
  testServerImages,
} from '../src/main/deploy/testing/testServerMachines';
import { createProject, type LaunchedApp, launchApp } from './app';
import { type FakeOllama, startFakeOllama } from './fakeOllama';
import {
  COMPOSE_WEB,
  composeWithWorker,
  containerOf,
  type FullStackServer,
  finishJob,
  SITE_DOMAIN,
  startFullStackServer,
} from './fullStackServer';
import { APP_ROOT } from './paths';
import { totpCode } from './totp';

/**
 * E17 AC1, the whole story in one run: the built app against a real systemd test server, the
 * published linux-x64 core, real Docker, nginx and a firewall on the server, and Pebble for the
 * certificate. Each step drives the UI and checks what it shows:
 *
 * 1. the server is added in Remote, picked for Deploy and the core installed from the wizard;
 * 2. two-factor goes on with a generated code, and the next sign-in asks for one;
 * 3. Docker is installed from Containers;
 * 4. a project's stack deploys with an environment from its Environments tab;
 * 5. a second revision pulls a private image from a registry:2 with htpasswd on the server;
 * 6. a site gets a domain from the test DNS and a certificate from Pebble;
 * 7. a firewall change nobody keeps reverts by itself;
 * 8. a container that keeps restarting is fixed by a command the Deploy AI proposes and the user
 *    approves, and the problem leaves the feed.
 *
 * Ubuntu 24.04 with ufw and Rocky 9 with firewalld (the distro images plus their firewall), since
 * step 7 needs a firewall. Needs AGENTMATE_SYSTEM_TESTS=1, Docker for Linux containers, network
 * access from the test server (Docker's and nginx's packages) and `pnpm server-core:publish
 * linux-x64`. The nightly workflow runs it; ordinary e2e runs skip it.
 */

test.skip(!systemTestsEnabled(), 'needs AGENTMATE_SYSTEM_TESTS=1 and Docker for Linux containers');

const IMAGES = testServerImages(
  ['ubuntu-24.04-ufw', 'rocky-9-firewalld'],
  ['ubuntu-24.04-ufw', 'rocky-9-firewalld'],
);
const ARTIFACTS = join(APP_ROOT, '..', 'server-core', 'artifacts', 'release');
const NICKNAME = 'Full stack';
const OWNER = 'maria';
const PASSWORD = 'correct horse battery staple';
const GREETING = 'hello from the full stack';
const PRIVATE_IMAGE = `${REGISTRY_HOST}/private/worker:1`;
const MINUTE = 60_000;

/** Opens a section of the selected server from the strip. */
async function openSection(page: Page, name: string): Promise<void> {
  await page
    .getByRole('navigation', { name: 'Server sections' })
    .getByRole('button', { name, exact: true })
    .click();
}

/** The New App wizard from its Source step on, the project and environment already picked. */
async function throughTheWizard(page: Page): Promise<void> {
  await expect(page.getByRole('list', { name: 'New app steps' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('list', { name: 'Env keys' }).getByText('GREETING')).toBeVisible({
    timeout: 30_000,
  });
  // The key shows, never its value.
  await expect(page.getByText(GREETING)).toHaveCount(0);
  await page.getByRole('button', { name: 'Next' }).click();
  await expect(page.getByRole('list', { name: 'Exposure' })).toBeVisible();
  await page.getByRole('button', { name: 'Next' }).click();
}

if (IMAGES.length === 0) {
  test('runs on none of the test servers asked for', () => {
    test.skip(true, 'AGENTMATE_TEST_SERVER_IMAGES names no full-stack server');
  });
}

for (const image of IMAGES) {
  test.describe(`the full stack on ${image}`, () => {
    // One story on one machine: a later step needs every earlier one, and a retry would mean
    // booting and installing everything again.
    test.describe.configure({ mode: 'serial', retries: 0 });

    let machine: FullStackServer | undefined;
    let ollama: FakeOllama | undefined;
    let launched: LaunchedApp | undefined;
    let authenticatorKey = '';

    const page = (): Page => {
      if (!launched) throw new Error('The app did not start');
      return launched.page;
    };
    const server = (): FullStackServer => {
      if (!machine) throw new Error('The test server did not start');
      return machine;
    };

    test.beforeAll(async () => {
      test.setTimeout(15 * MINUTE);
      machine = await startFullStackServer(image);
      ollama = await startFakeOllama([]);
      launched = await launchApp({
        settings: {
          promptBuilderProvider: 'ollama',
          ollamaModel: 'e2e-script',
          ollamaBaseUrl: ollama.url,
        },
        env: { AGENTMATE_SERVER_CORE_ARTIFACTS: ARTIFACTS },
      });
    });

    test.afterEach(async () => {
      const info = test.info();
      if (info.status === info.expectedStatus || !machine) return;
      const details = [machine.server.diagnose(), (launched?.mainLog() ?? '').slice(-8_000)];
      await info.attach('server and app', { body: details.join('\n\n') });
      // biome-ignore lint/suspicious/noConsole: the CI log is all there is to see where a run stopped
      console.log(details.join('\n\n'));
    });

    test.afterAll(async () => {
      await launched?.close();
      await ollama?.close();
      machine?.stop();
    });

    test('1. adds the server in Remote and installs the core from the Deploy wizard', async () => {
      test.setTimeout(15 * MINUTE);
      const { host, port } = server().server;
      const app = page();
      await app.evaluate(() => {
        location.hash = '#/remote';
      });
      await app.getByRole('button', { name: 'SSH', exact: true }).click();
      await app.getByRole('button', { name: 'Add server' }).first().click();
      const form = app.getByRole('dialog', { name: 'Add server' });
      await form.getByLabel('Nickname').fill(NICKNAME);
      await form.getByLabel('Host').fill(host);
      await form.getByLabel('Port').fill(String(port));
      await form.getByLabel('Username').fill(TEST_LOGINS.deployer.username);
      await form.getByLabel('Password').fill(TEST_LOGINS.deployer.password);
      await form.getByRole('button', { name: 'Add server' }).click();
      await expect(form).toBeHidden();
      await expect(app.getByRole('listitem').filter({ hasText: NICKNAME })).toBeVisible();

      await app.getByRole('link', { name: 'Deploy' }).click();
      // Deploy lists only the servers the user chose, so the one just saved is picked first.
      await app.getByRole('button', { name: 'Choose servers to show' }).click();
      const pick = app.getByRole('dialog', { name: 'Choose servers to show' });
      await pick.getByRole('checkbox', { name: new RegExp(NICKNAME) }).click();
      await pick.getByRole('button', { name: 'Save' }).click();
      const rail = app.getByRole('navigation', { name: 'Servers' });
      await expect(rail.getByText(NICKNAME)).toBeVisible({ timeout: 30_000 });
      // A fresh server: the core is new, so the owner is created with it.
      const install = app.getByRole('button', { name: /^Install core / });
      await expect(install).toBeVisible({ timeout: 2 * MINUTE });
      await expect(app.getByText('sudo will use the saved login password.')).toBeVisible();
      await app.getByLabel('User name').fill(OWNER);
      await app.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await app.getByLabel('Confirm the password').fill(PASSWORD);
      await install.click();
      await expect(app.getByRole('list', { name: 'Install steps' })).toBeVisible();

      await expect(rail.getByText(/^Online, core /)).toBeVisible({ timeout: 10 * MINUTE });
      await expect(app.getByText(/Signed in as/)).toBeVisible({ timeout: 60_000 });
      expect(server().sh('systemctl is-active agentmate-core')).toBe('active');
    });

    test('2. turns two-factor on with a generated code and asks for one at sign-in', async () => {
      test.setTimeout(5 * MINUTE);
      const app = page();
      await expect(app.getByText(/Two-factor is off/)).toBeVisible({ timeout: 30_000 });
      await app.getByRole('button', { name: 'Turn on two-factor' }).click();
      let dialog = app.getByRole('dialog', { name: 'Turn on two-factor' });
      await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await dialog.getByRole('button', { name: 'Continue' }).click();
      await expect(dialog.getByAltText('QR code with the new authenticator key')).toBeVisible();
      authenticatorKey = (await dialog.getByLabel('Authenticator key').textContent()) ?? '';
      await dialog.getByLabel('Code from the app').fill(totpCode(authenticatorKey));
      await dialog.getByRole('button', { name: 'Turn on', exact: true }).click();
      await expect(
        dialog.getByRole('list', { name: 'Recovery codes' }).getByRole('listitem'),
      ).toHaveCount(10);
      await dialog.getByRole('button', { name: 'I saved them' }).click();
      await expect(dialog).toBeHidden();
      await expect(app.getByText(/Two-factor is on: signing in/)).toBeVisible();

      // The code that turned it on is spent, so the sign-in takes the next one.
      await app.getByRole('button', { name: 'Sign out' }).click();
      await app.getByRole('button', { name: 'Sign in', exact: true }).click();
      dialog = app.getByRole('dialog', { name: `Sign in to ${NICKNAME}` });
      await dialog.getByLabel('Password', { exact: true }).fill(PASSWORD);
      await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
      await dialog.getByLabel('Authenticator code').fill(totpCode(authenticatorKey, 1));
      await dialog.getByRole('button', { name: 'Sign in', exact: true }).click();
      await expect(dialog).toBeHidden();
      await expect(app.getByText(/Signed in as/)).toBeVisible();
      await expect(app.getByText(/Two-factor is on: signing in/)).toBeVisible();
    });

    test('3. installs Docker from Containers', async () => {
      test.setTimeout(45 * MINUTE);
      const app = page();
      await openSection(app, 'Containers');
      const card = app.getByRole('region', { name: 'Docker' });
      await expect(card.getByText(`Docker is not installed on ${NICKNAME}`)).toBeVisible({
        timeout: 60_000,
      });
      // Docker's packages come over the network, which fails now and then: up to three tries.
      let outcome = '';
      for (let attempt = 1; attempt <= 3 && !/Done/.test(outcome); attempt++) {
        if (await card.getByRole('list', { name: 'Packages in the way' }).isVisible()) {
          await card.getByRole('checkbox').check();
        }
        await card.getByRole('button', { name: 'Install Docker' }).click();
        outcome = await finishJob(app, 20 * MINUTE);
      }
      expect(outcome).toMatch(/Done/);
      await expect(app.getByLabel('Docker version')).toContainText(/Docker \d+/, {
        timeout: 60_000,
      });
    });

    test('4. deploys a project stack with an environment from its Environments tab', async () => {
      test.setTimeout(15 * MINUTE);
      const app = page();
      const launchedApp = launched as LaunchedApp;
      loadImage(server().server.name, 'busybox:1.37');
      writeFileSync(join(launchedApp.projectDir, 'compose.yaml'), COMPOSE_WEB);
      const projectId = await createProject(launchedApp);
      // What the project's Environments tab saves, through the same bridge it uses.
      await app.evaluate(
        async ({ id, greeting }) => {
          const api = (
            window as unknown as {
              agentmat: {
                environments: {
                  save(input: unknown): Promise<{ id: string }>;
                  saveFile(input: unknown): Promise<unknown>;
                };
              };
            }
          ).agentmat.environments;
          const environment = await api.save({
            projectId: id,
            name: 'Production',
            kind: 'production',
          });
          await api.saveFile({
            environmentId: environment.id,
            fileName: '.env',
            content: `GREETING="${greeting}"\n`,
          });
        },
        { id: projectId, greeting: GREETING },
      );
      await app.reload();

      await openSection(app, 'Apps');
      await expect(app.getByText('No apps on this server yet')).toBeVisible({ timeout: 60_000 });
      await app.getByRole('button', { name: 'New app' }).click();
      await app.getByRole('combobox', { name: 'Project', exact: true }).click();
      await app.getByRole('option', { name: 'e2e project' }).click();
      await app.getByRole('radio', { name: /compose\.yaml/ }).check();
      await app.getByRole('combobox', { name: 'Environment', exact: true }).click();
      await app.getByRole('option', { name: /^Production/ }).click();
      await app.getByLabel('App name').fill('shop');
      await throughTheWizard(app);
      await app.getByRole('button', { name: 'Deploy shop' }).click();

      const steps = app.getByRole('list', { name: 'Deploy steps' });
      await expect(steps).toBeVisible({ timeout: 60_000 });
      for (const step of ['Validate', 'Pull images', 'Build', 'Start containers', 'Health check']) {
        await expect(steps.getByRole('listitem', { name: step })).toBeVisible();
      }
      await expect(app.getByText('Revision 1 is live.')).toBeVisible({ timeout: 10 * MINUTE });
      // The environment's value reached the container, and the page it serves.
      expect(server().sh('curl -s http://127.0.0.1:8080/')).toBe(GREETING);
    });

    test('5. pulls a private image from a registry with a sign-in from this computer', async () => {
      test.setTimeout(15 * MINUTE);
      const app = page();
      const launchedApp = launched as LaunchedApp;
      startPrivateRegistry(server().server.name, 'busybox:1.37', PRIVATE_IMAGE);
      expect(server().sh(`docker pull ${PRIVATE_IMAGE} 2>&1 || true`)).toMatch(
        /unauthorized|no basic auth/,
      );

      // Back to the list of apps, by way of another section.
      await openSection(app, 'Overview');
      await openSection(app, 'Apps');
      const apps = app.getByRole('list', { name: 'Apps' });
      await expect(apps.getByRole('listitem', { name: 'shop' })).toBeVisible({ timeout: 60_000 });
      await app.getByRole('button', { name: 'Registries' }).click();
      await expect(app.getByText(/No sign-ins yet/)).toBeVisible({ timeout: 30_000 });
      await app.getByRole('button', { name: /Custom registry/ }).click();
      const dialog = app.getByRole('dialog', { name: /Custom registry/ });
      await dialog.getByLabel('Registry host').fill(REGISTRY_HOST);
      await dialog.getByLabel('User name').fill(REGISTRY_PULLER);
      await dialog.getByLabel('Access token or password').fill(REGISTRY_TOKEN);
      await dialog.getByRole('button', { name: /Save sign-in/ }).click();
      await expect(
        app
          .getByRole('list', { name: 'Sign-ins on this computer' })
          .getByRole('listitem', { name: REGISTRY_HOST }),
      ).toBeVisible();
      await app
        .getByRole('region', { name: 'Registries' })
        .getByRole('button', { name: 'Apps' })
        .click();

      // A second revision of the same app, with a worker from the private image.
      writeFileSync(join(launchedApp.projectDir, 'compose.yaml'), composeWithWorker(PRIVATE_IMAGE));
      await apps.getByRole('listitem', { name: 'shop' }).getByRole('button').first().click();
      await expect(app.getByRole('heading', { name: 'shop' })).toBeVisible({ timeout: 30_000 });
      await app.getByRole('button', { name: 'Deploy again' }).click();
      await throughTheWizard(app);
      const plan = app.getByRole('list', { name: 'Registries this app pulls from' });
      await expect(plan.getByRole('listitem', { name: REGISTRY_HOST })).toContainText(
        /from this computer goes with the deploy/,
        { timeout: 30_000 },
      );
      await app.getByRole('button', { name: 'Deploy shop' }).click();
      await expect(app.getByText('Revision 2 is live.')).toBeVisible({ timeout: 10 * MINUTE });
      await expect(app.getByText(REGISTRY_TOKEN)).toHaveCount(0);
      expect(server().sh(`docker image inspect -f '{{.Id}}' ${PRIVATE_IMAGE}`)).toMatch(/^sha256:/);
    });

    test('6. adds a site on a test domain and issues a certificate from Pebble', async () => {
      test.setTimeout(30 * MINUTE);
      const app = page();
      // Where the firewall is on (firewalld on Rocky), the CA's check of port 80 needs it open:
      // the HTTP preset, applied and kept, as anyone setting up a site would.
      await openSection(app, 'Firewall');
      const state = app.getByLabel('Firewall state');
      await expect(state).toContainText(/Firewall (on|off)/, { timeout: 60_000 });
      if ((await state.textContent())?.includes('Firewall on')) {
        await app.getByRole('button', { name: 'Stage the HTTP preset' }).click();
        await app
          .getByRole('region', { name: 'Staged changes' })
          .getByRole('button', { name: 'Review and apply' })
          .click();
        await applyReviewed(app);
        await app.getByRole('button', { name: 'Keep changes' }).click();
        await expect(app.getByText('Firewall change kept.')).toBeVisible({ timeout: 60_000 });
      }

      await openSection(app, 'Websites');
      const setUp = app.getByRole('button', { name: /Set up nginx for AgentMate|Install nginx/ });
      await expect(setUp.or(app.getByText('Managed by AgentMate'))).toBeVisible({
        timeout: 60_000,
      });
      if (await setUp.isVisible()) {
        await setUp.click();
        expect(await finishJob(app, 15 * MINUTE)).toMatch(/Done/);
      }
      await expect(app.getByText('Managed by AgentMate')).toBeVisible({ timeout: 60_000 });

      // The site sends its domain to the app's web service on this server.
      await app.getByRole('button', { name: /Add a site/ }).click();
      await app.getByRole('textbox', { name: 'Domain 1' }).fill(SITE_DOMAIN);
      await app.getByRole('tab', { name: 'Proxy' }).click();
      await app.getByLabel('Service name').fill('shop');
      await app.getByLabel('Port').fill('8080');
      await app.getByRole('button', { name: /Save the site/ }).click();
      await expect(app.getByRole('tab', { name: 'SSL', selected: true })).toBeVisible({
        timeout: 60_000,
      });
      const bar = app.getByRole('region', { name: 'Apply changes' });
      await expect(bar.getByText(/Saved changes are waiting/)).toBeVisible({ timeout: 60_000 });
      await bar.getByRole('button', { name: /Apply changes/ }).click();
      await expect(bar).toBeHidden({ timeout: 2 * MINUTE });

      // Pebble checks the domain over HTTP-01 against this server's nginx, then signs.
      await app.getByRole('button', { name: 'Issue a certificate' }).click();
      const order = app.getByRole('dialog', { name: 'Issue a certificate' });
      await order.getByRole('checkbox').click();
      await order.getByRole('button', { name: 'Issue the certificate' }).click();
      expect(await finishJob(app, 5 * MINUTE)).toMatch(/Done/);
      await expect(app.getByText(/SSL, (89|90) days/).first()).toBeVisible({ timeout: 60_000 });

      await app.getByRole('button', { name: /All sites/ }).click();
      const row = app
        .getByRole('list', { name: 'Sites' })
        .getByRole('listitem', { name: SITE_DOMAIN });
      await expect(row.getByText(/^SSL, (89|90) days$/)).toBeVisible({ timeout: 60_000 });
      await expect(row.getByText('Live')).toBeVisible({ timeout: 60_000 });
      // nginx serves the app over HTTPS with a certificate that chains to Pebble's root.
      const served = server().sh(
        `curl -sf -o /tmp/pebble-root.pem https://pebble:15000/roots/0 && curl -sS --cacert /tmp/pebble-root.pem --resolve ${SITE_DOMAIN}:443:127.0.0.1 https://${SITE_DOMAIN}/`,
      );
      expect(served).toBe(GREETING);
    });

    test('7. applies a firewall change nobody keeps, and it reverts by itself', async () => {
      test.setTimeout(10 * MINUTE);
      const app = page();
      await openSection(app, 'Firewall');
      const state = app.getByLabel('Firewall state');
      await expect(state).toContainText(/Firewall (on|off)/, { timeout: 60_000 });
      const wasOn = (await state.textContent())?.includes('Firewall on') ?? false;

      if (wasOn) {
        // firewalld: a new port, as in firewall.e2e.ts.
        await app.getByRole('button', { name: 'Add rule' }).click();
        const form = app.getByRole('dialog', { name: 'Add a rule' });
        await form.getByLabel('Ports').fill('8081');
        await form.getByLabel('Comment').fill('full stack');
        await form.getByRole('button', { name: 'Stage the rule' }).click();
        const staged = app.getByRole('region', { name: 'Staged changes' });
        await expect(staged.getByText('Add: Allow port 8081 TCP')).toBeVisible();
        await staged.getByRole('button', { name: 'Review and apply' }).click();
      } else {
        // ufw, off as on a fresh VPS: turning it on, with SSH's own rule so the guard lets it.
        await app.getByRole('button', { name: 'Stage the SSH preset' }).click();
        await app.getByRole('button', { name: 'Turn on', exact: true }).click();
      }
      await applyReviewed(app);
      if (wasOn) {
        await expect(app.getByRole('row', { name: 'Rule 8081 Anywhere' })).toBeVisible({
          timeout: 30_000,
        });
      } else {
        await expect(state).toContainText('Firewall on', { timeout: 30_000 });
        expect(server().sh('ufw status')).toContain('Status: active');
      }

      // Nobody keeps it: the core's timer puts the old rules back at the deadline.
      await expect(app.getByRole('timer')).toBeHidden({ timeout: 3 * MINUTE });
      await expect(
        app.getByText('Nobody kept the firewall change in time, so the old rules are back.'),
      ).toBeVisible({ timeout: 60_000 });
      const latest = app
        .getByRole('list', { name: 'Change history' })
        .getByRole('listitem')
        .first();
      await expect(latest.getByText(/Rolled back: nobody kept it in time/)).toBeVisible({
        timeout: 60_000,
      });
      if (wasOn) {
        await expect(app.getByRole('row', { name: 'Rule 8081 Anywhere' })).toBeHidden({
          timeout: 60_000,
        });
        expect(server().sh('firewall-cmd --zone=public --list-ports')).not.toContain('8081');
      } else {
        await expect(state).toContainText('Firewall off', { timeout: 60_000 });
        expect(server().sh('ufw status')).toContain('Status: inactive');
      }
    });

    test('8. fixes a container that keeps restarting with a command the Deploy AI proposes', async () => {
      test.setTimeout(15 * MINUTE);
      const app = page();
      const web = containerOf(server(), 'web');
      const worker = containerOf(server(), 'worker');
      // Break it: without web, the worker exits at once on every start.
      server().sh(`docker stop ${web}`);

      await openSection(app, 'Logs');
      const problems = app.getByRole('list', { name: 'Problems' });
      const crash = problems.getByRole('listitem', { name: `${worker} keeps restarting` });
      await expect(crash).toBeVisible({ timeout: 3 * MINUTE });
      await expect(crash.getByText('Crash loop')).toBeVisible();

      ollama?.say(
        `RUN: docker start ${web} && docker restart ${worker}`,
        'FINISHED: The worker lost the web service it checks; started web and restarted it.',
      );
      await crash.getByRole('button', { name: 'Diagnose with AI' }).click();
      const drawer = app.getByRole('complementary', { name: 'Deploy AI' });
      await expect(drawer.getByLabel('Context')).toContainText(`${worker} keeps restarting`);
      await expect(drawer.getByRole('radio', { name: /Approve every command/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await drawer.getByRole('button', { name: 'Start' }).click();

      // The fix waits for the user, who reads it and runs it.
      const approval = drawer.getByRole('group', { name: 'Approve the command' });
      await expect(approval).toContainText(`docker start ${web}`, { timeout: 2 * MINUTE });
      await approval.getByRole('button', { name: 'Run it' }).click();
      const step = drawer.getByRole('listitem', {
        name: `Step 1: docker start ${web} && docker restart ${worker}`,
      });
      await expect(step.getByLabel('Status')).toHaveText('Done', { timeout: 2 * MINUTE });
      await expect(step.getByLabel('Output of step 1')).toContainText(worker);
      await expect(drawer.getByText(/Finished: The worker lost the web service/)).toBeVisible({
        timeout: 2 * MINUTE,
      });

      // Both run again, and the feed drops the crash loop on its next look.
      await expect(crash).toHaveCount(0, { timeout: 3 * MINUTE });
      expect(server().sh(`docker inspect -f '{{.State.Status}}' ${web} ${worker}`)).toBe(
        'running\nrunning',
      );
      // What the model read about the container came in as untrusted data, after the rules.
      const prompt = ollama?.prompts[0] ?? '';
      expect(prompt.indexOf('Rules:')).toBeGreaterThan(-1);
      expect(prompt.indexOf('Rules:')).toBeLessThan(prompt.indexOf('BEGIN UNTRUSTED DATA'));
    });
  });
}

/** Applies the change the review dialog shows, and waits for the countdown to start. */
async function applyReviewed(page: Page): Promise<void> {
  const review = page.getByRole('dialog', { name: 'Review the firewall change' });
  await expect(review.getByLabel('Commands')).not.toBeEmpty({ timeout: 60_000 });
  await review.getByRole('button', { name: 'Apply', exact: true }).click();
  // Turning the firewall on takes the password again; adding a rule does not.
  const proof = page.getByRole('dialog', { name: /Confirm it is you/ });
  const keep = page.getByRole('heading', { name: 'Keep changes?' });
  await expect(proof.or(keep)).toBeVisible({ timeout: 2 * MINUTE });
  if (await proof.isVisible()) {
    await proof.getByLabel('Password', { exact: true }).fill(PASSWORD);
    await proof.getByRole('button', { name: 'Confirm' }).click();
  }
  await expect(keep).toBeVisible({ timeout: 2 * MINUTE });
  await expect(review).toBeHidden();
  await expect(page.getByRole('timer')).toHaveAttribute('aria-label', /^\d+ seconds left$/);
}
