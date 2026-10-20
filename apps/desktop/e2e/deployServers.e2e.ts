import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Which servers the Deploy page lists, in the built app. Servers saved in Remote stay out of it
 * until the user picks them, and the rail keeps the order they drag or key them into, across the
 * settings file. The servers point at nothing: the rail lists them without a connection, so no
 * machine has to answer.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

const NICKNAMES = ['Alpha', 'Bravo', 'Charlie'];

interface Saved {
  id: string;
  nickname: string;
}

/** Saves the servers through the app, as Remote's form does, and returns them with their ids. */
async function saveServers(page: Page): Promise<Saved[]> {
  return page.evaluate(async (nicknames) => {
    const ssh = (
      window as unknown as {
        agentmat: {
          ssh: {
            saveServer(input: unknown): Promise<{ id: string; nickname: string }>;
          };
        };
      }
    ).agentmat.ssh;
    const saved: { id: string; nickname: string }[] = [];
    for (const nickname of nicknames) {
      saved.push(
        await ssh.saveServer({
          nickname,
          host: '127.0.0.1',
          port: 1,
          username: 'deployer',
          authMethod: 'password',
          secret: 'not-used',
        }),
      );
    }
    return saved;
  }, NICKNAMES);
}

async function openDeploy(page: Page): Promise<void> {
  await page.getByRole('link', { name: 'Deploy', exact: true }).click();
}

/** The rail's server rows, top to bottom. */
function rows(page: Page): Locator {
  return page.getByRole('navigation', { name: 'Servers' }).locator('[data-reorder-id]');
}

async function boxOf(
  locator: Locator,
): Promise<{ x: number; y: number; width: number; height: number }> {
  const box = await locator.boundingBox();
  if (!box) throw new Error('The row has no box on screen');
  return box;
}

async function chooseServers(page: Page, nicknames: string[]): Promise<void> {
  const dialog = page.getByRole('dialog', { name: 'Choose servers to show' });
  for (const nickname of nicknames) {
    await dialog.getByRole('checkbox', { name: new RegExp(nickname) }).click();
  }
  await dialog.getByRole('button', { name: 'Save' }).click();
  await expect(dialog).toBeHidden();
}

test('lists only the servers picked, and remembers the pick', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const [alpha, , charlie] = await saveServers(page);
  await openDeploy(page);

  // Three servers are saved and none is picked: Deploy says so instead of listing them.
  await expect(page.getByText('No servers chosen yet')).toBeVisible();
  await expect(page.getByText(/You have 3 saved servers/)).toBeVisible();
  await expect(page.getByRole('navigation', { name: 'Servers' })).toHaveCount(0);

  await page.getByRole('button', { name: 'Choose servers to show' }).click();
  await chooseServers(page, ['Charlie', 'Alpha']);

  await expect(rows(page)).toHaveText([/^Alpha/, /^Charlie/]);
  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
  await expect(rows(page).filter({ hasText: 'Bravo' })).toHaveCount(0);
  await expect
    .poll(() => launched?.settingsOnDisk().deployServerIds)
    .toEqual([alpha.id, charlie.id]);

  // The picker opens on what is shown, and a later pick joins the end of the rail.
  await page
    .getByRole('navigation', { name: 'Servers' })
    .getByRole('button', { name: 'Choose servers to show' })
    .click();
  const dialog = page.getByRole('dialog', { name: 'Choose servers to show' });
  await expect(dialog.getByRole('checkbox', { name: /Alpha/ })).toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Bravo/ })).not.toBeChecked();
  await expect(dialog.getByRole('checkbox', { name: /Charlie/ })).toBeChecked();
  await chooseServers(page, ['Bravo']);
  await expect(rows(page)).toHaveText([/^Alpha/, /^Charlie/, /^Bravo/]);
});

test('drags a server to a new place and keeps it there', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const [alpha, bravo, charlie] = await saveServers(page);
  await openDeploy(page);
  await page.getByRole('button', { name: 'Choose servers to show' }).click();
  await chooseServers(page, NICKNAMES);
  await expect(rows(page)).toHaveText([/^Alpha/, /^Bravo/, /^Charlie/]);

  const first = await boxOf(rows(page).nth(0));
  const second = await boxOf(rows(page).nth(1));
  const x = first.x + first.width / 2;
  // Down onto the first row and over the middle of the second, in steps so the drag registers.
  await page.mouse.move(x, first.y + first.height / 2);
  await page.mouse.down();
  await page.mouse.move(x, first.y + first.height / 2 + 6, { steps: 3 });
  await page.mouse.move(x, second.y + second.height / 2 + 4, { steps: 8 });
  await page.mouse.up();

  await expect(rows(page)).toHaveText([/^Bravo/, /^Alpha/, /^Charlie/]);
  await expect
    .poll(() => launched?.settingsOnDisk().deployServerIds)
    .toEqual([bravo.id, alpha.id, charlie.id]);
  // The page was on Alpha before the drag, and moving it down did not switch to another server.
  await expect(page.getByRole('heading', { name: 'Alpha' })).toBeVisible();
});

test('moves a server with Alt and the arrow keys, and the keyboard stays on it', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const [alpha, bravo, charlie] = await saveServers(page);
  await openDeploy(page);
  await page.getByRole('button', { name: 'Choose servers to show' }).click();
  await chooseServers(page, NICKNAMES);
  await expect(rows(page)).toHaveText([/^Alpha/, /^Bravo/, /^Charlie/]);

  const charlieRow = rows(page).filter({ hasText: 'Charlie' }).getByRole('button');
  await charlieRow.focus();
  await page.keyboard.press('Alt+ArrowUp');
  await expect(rows(page)).toHaveText([/^Alpha/, /^Charlie/, /^Bravo/]);
  await expect(charlieRow).toBeFocused();

  await page.keyboard.press('Alt+ArrowUp');
  await expect(rows(page)).toHaveText([/^Charlie/, /^Alpha/, /^Bravo/]);
  await expect(charlieRow).toBeFocused();
  await expect
    .poll(() => launched?.settingsOnDisk().deployServerIds)
    .toEqual([charlie.id, alpha.id, bravo.id]);
});

test('takes a server off the rail and drops it from the saved choice', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  const [alpha, , charlie] = await saveServers(page);
  await openDeploy(page);
  await page.getByRole('button', { name: 'Choose servers to show' }).click();
  await chooseServers(page, NICKNAMES);

  await page
    .getByRole('navigation', { name: 'Servers' })
    .getByRole('button', { name: 'Choose servers to show' })
    .click();
  await chooseServers(page, ['Bravo']);

  await expect(rows(page)).toHaveText([/^Alpha/, /^Charlie/]);
  await expect
    .poll(() => launched?.settingsOnDisk().deployServerIds)
    .toEqual([alpha.id, charlie.id]);
});
