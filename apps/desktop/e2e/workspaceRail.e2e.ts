import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * The project rail is how a user moves between workspaces, so a click on a tile has to land.
 *
 * The tiles are also the drag grips for reordering. A grip that captured the pointer on press
 * made Chromium send the click that follows to the grip's wrapper instead of the button inside
 * it, so the button's onClick never ran and no tile could be opened. Component tests in jsdom
 * cannot see that (it has no pointer capture), and the other e2e specs switch projects with
 * `element.click()` or by setting the hash, which skip the pointer events entirely. These tests
 * use real mouse input.
 */

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

async function createProject(page: Page, name: string, folderPath: string): Promise<string> {
  return page.evaluate(
    async ({ name, folderPath }) => {
      const api = (
        window as unknown as {
          runova: { projects: { create(input: unknown): Promise<{ id: string }> } };
        }
      ).runova;
      const project = await api.projects.create({
        name,
        folderPath,
        description: '',
        tags: [],
        agentType: 'claude-code',
        notes: '',
        runCommands: [],
      });
      return project.id;
    },
    { name, folderPath },
  );
}

/** Three projects with an open workspace each, so all of them sit on the rail. */
async function openThreeWorkspaces(app: LaunchedApp): Promise<string[]> {
  const { page, root } = app;
  const names = ['alpha', 'bravo', 'charlie'];
  const ids: string[] = [];
  for (const name of names) {
    const dir = join(root, name);
    mkdirSync(dir, { recursive: true });
    ids.push(await createProject(page, name, dir));
  }
  // Projects made through IPC are not in the cached list yet, so the page reloads first. Each
  // workspace is then opened by hash and waited for, since hash changes made back to back are
  // folded into the last one and the rail would only get that project.
  await page.reload();
  for (const [index, id] of ids.entries()) {
    await page.evaluate((id) => {
      location.hash = `#/workspace/${id}`;
    }, id);
    await expect(tile(page, names[index])).toBeVisible({ timeout: 60_000 });
  }
  return ids;
}

function tile(page: Page, name: string) {
  return page.getByRole('button', { name: `Open ${name}`, exact: true });
}

/** The rail's project tiles, top to bottom. */
async function railOrder(page: Page): Promise<string[]> {
  const labels = await page
    .getByRole('navigation', { name: 'Open workspaces' })
    .getByRole('button', { name: /^Open (alpha|bravo|charlie)$/ })
    .evaluateAll((buttons) => buttons.map((button) => button.getAttribute('aria-label') ?? ''));
  return labels.map((label) => label.replace(/^Open /, ''));
}

function currentHash(page: Page): Promise<string> {
  return page.evaluate(() => location.hash);
}

test('clicking a project on the rail opens its workspace', async () => {
  launched = await launchApp({ settings: { defaultCliId: 'claude-code' } });
  const { page } = launched;
  const [alpha, bravo, charlie] = await openThreeWorkspaces(launched);

  // Real mouse input, one press and release with no movement in between.
  await tile(page, 'alpha').click();
  await expect(tile(page, 'alpha')).toHaveAttribute('aria-current', 'page');
  expect(await currentHash(page)).toBe(`#/workspace/${alpha}`);

  await tile(page, 'charlie').click();
  await expect(tile(page, 'charlie')).toHaveAttribute('aria-current', 'page');
  await expect(tile(page, 'alpha')).not.toHaveAttribute('aria-current', 'page');
  expect(await currentHash(page)).toBe(`#/workspace/${charlie}`);

  await tile(page, 'bravo').click();
  await expect(tile(page, 'bravo')).toHaveAttribute('aria-current', 'page');
  expect(await currentHash(page)).toBe(`#/workspace/${bravo}`);

  // And back again, which is the "cannot switch between projects" case.
  await tile(page, 'alpha').click();
  await expect(tile(page, 'alpha')).toHaveAttribute('aria-current', 'page');
  expect(await currentHash(page)).toBe(`#/workspace/${alpha}`);
});

test('dragging a rail tile reorders the rail without opening the tile', async () => {
  launched = await launchApp({ settings: { defaultCliId: 'claude-code' } });
  const { page } = launched;
  const [, , charlie] = await openThreeWorkspaces(launched);

  // Start from a known workspace, so an accidental open of another one shows as a change.
  await tile(page, 'charlie').click();
  await expect(tile(page, 'charlie')).toHaveAttribute('aria-current', 'page');
  const before = await railOrder(page);
  expect(before).toEqual(['alpha', 'bravo', 'charlie']);

  const grip = await tile(page, 'alpha').boundingBox();
  const target = await tile(page, 'bravo').boundingBox();
  if (!grip || !target) throw new Error('The rail tiles have no layout');

  // Drag alpha down past bravo, in steps so the pointer really travels.
  const fromX = grip.x + grip.width / 2;
  const fromY = grip.y + grip.height / 2;
  await page.mouse.move(fromX, fromY);
  await page.mouse.down();
  await page.mouse.move(fromX, fromY + 10, { steps: 4 });
  await page.mouse.move(fromX, target.y + target.height / 2 + 12, { steps: 12 });
  await page.mouse.up();

  await expect.poll(() => railOrder(page)).toEqual(['bravo', 'alpha', 'charlie']);
  // Letting go of a dragged tile must not also open it.
  expect(await currentHash(page)).toBe(`#/workspace/${charlie}`);
  await expect(tile(page, 'charlie')).toHaveAttribute('aria-current', 'page');

  // A drag that ended must not leave the next plain click swallowed.
  await tile(page, 'alpha').click();
  await expect(tile(page, 'alpha')).toHaveAttribute('aria-current', 'page');
});

/**
 * The thickness of the horizontal scrollbar on the rail's scroller, 0 when it has none. This is
 * what a user sees as a grey bar between the last tile and the "+" button.
 */
function horizontalScrollbar(page: Page): Promise<number> {
  return page
    .locator('nav[aria-label="Open workspaces"] .rail-scroll')
    .evaluate((scroller: HTMLElement) => scroller.offsetHeight - scroller.clientHeight);
}

/** Lets React and the browser apply what the last input did. */
async function settle(page: Page): Promise<void> {
  await page.evaluate(
    () =>
      new Promise<void>((resolve) => {
        const channel = new MessageChannel();
        let turns = 0;
        channel.port1.onmessage = () => {
          turns += 1;
          if (turns < 5) channel.port2.postMessage(null);
          else setTimeout(resolve, 60);
        };
        channel.port2.postMessage(null);
      }),
  );
}

// A pressed tile is lifted with a 5% scale, which makes it a pixel or two wider than the rail.
// With the scroller free to scroll sideways that grew a horizontal scrollbar under the last
// tile, and every click made it flash.
test('pressing or dragging a rail tile never gives the rail a horizontal scrollbar', async () => {
  launched = await launchApp({ settings: { defaultCliId: 'claude-code' } });
  const { page } = launched;
  await openThreeWorkspaces(launched);

  const box = await tile(page, 'bravo').boundingBox();
  if (!box) throw new Error('The rail tile has no layout');
  const x = box.x + box.width / 2;
  const y = box.y + box.height / 2;

  await page.mouse.move(x, y);
  await settle(page);
  expect(await horizontalScrollbar(page), 'hovering').toBe(0);

  await page.mouse.down();
  await settle(page);
  expect(await horizontalScrollbar(page), 'pressed').toBe(0);

  // Dragging lifts the tile for as long as it is held.
  await page.mouse.move(x, y + 12, { steps: 4 });
  await settle(page);
  expect(await horizontalScrollbar(page), 'dragging').toBe(0);

  await page.mouse.up();
  await settle(page);
  expect(await horizontalScrollbar(page), 'dropped').toBe(0);
});
