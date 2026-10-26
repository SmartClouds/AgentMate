import { existsSync, mkdirSync, readdirSync, writeFileSync } from 'node:fs';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import { expect, type Locator, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp, openWorkspace } from './app';

/**
 * The workspace browser tab in the real app, against a page served for the test: it loads in a
 * webview laid exactly over its pane, keeps its state when the tab is switched away from and the
 * pane is split, and an element clicked in comment mode opens the comment card, gets its
 * screenshot saved and a pin drawn on the page. These are the parts jsdom cannot show.
 *
 * RUNOVA_E2E_SHOTS=<folder> saves a screenshot of each step, for looking the UI over.
 */

const PAGE = `<!doctype html>
<html>
  <head><title>Fixture Shop</title>
  <style>
    body { font-family: system-ui, sans-serif; margin: 0; background: #f7f7f5; color: #111; }
    header { padding: 24px 32px; background: #111; color: #fff; }
    .plans { display: flex; gap: 16px; padding: 32px; }
    .card { flex: 1; background: #fff; border-radius: 12px; padding: 24px; box-shadow: 0 1px 3px #0002; }
    button.buy { margin-top: 16px; padding: 10px 18px; border: 0; border-radius: 8px; background: #16a34a; color: #fff; font-size: 15px; }
  </style></head>
  <body>
    <header><h1>Fixture Shop</h1></header>
    <section class="plans">
      <div class="card"><h2>Starter</h2><p>For one person.</p>
        <button class="buy" id="buy" type="button">Buy now</button></div>
      <div class="card"><h2>Team</h2><p>For the whole team.</p>
        <button class="buy" type="button">Talk to sales</button></div>
    </section>
    <script>
      let clicks = 0;
      document.getElementById('buy').addEventListener('click', () => {
        clicks += 1;
        document.getElementById('buy').dataset.clicks = String(clicks);
      });
    </script>
  </body>
</html>`;

let launched: LaunchedApp | undefined;
let server: Server | undefined;
const shotsDir = process.env.RUNOVA_E2E_SHOTS;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
  await new Promise<void>((resolve) => (server ? server.close(() => resolve()) : resolve()));
  server = undefined;
});

async function serve(): Promise<string> {
  const http = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
    response.end(PAGE);
  });
  server = http;
  await new Promise<void>((resolve) => http.listen(0, '127.0.0.1', resolve));
  return `http://localhost:${(http.address() as AddressInfo).port}/`;
}

/**
 * What the window really shows, taken by Electron from the compositor. Playwright's own
 * screenshot goes through the devtools protocol, which draws a webview's page wrongly once that
 * page has itself been captured.
 */
async function shot(_page: Page, name: string): Promise<void> {
  if (!shotsDir || !launched) return;
  mkdirSync(shotsDir, { recursive: true });
  // The compositor's copy trails the DOM by a frame or two.
  await new Promise((resolve) => setTimeout(resolve, 400));
  const png = await launched.app.evaluate(async ({ BrowserWindow }) => {
    const win =
      BrowserWindow.getAllWindows().find((one) => one.isVisible()) ??
      BrowserWindow.getAllWindows()[0];
    const image = await win?.webContents.capturePage();
    return image ? image.toPNG().toString('base64') : '';
  });
  writeFileSync(join(shotsDir, `${name}.png`), Buffer.from(png, 'base64'));
}

/** Runs script in the page of the browser tab, through its webview's own webContents. */
function inGuest<Result>(app: LaunchedApp, script: string): Promise<Result> {
  return app.app.evaluate(async ({ webContents }, code) => {
    const guest = webContents.getAllWebContents().find((one) => one.getType() === 'webview');
    if (!guest) throw new Error('no browser page');
    return guest.executeJavaScript(code);
  }, script) as Promise<Result>;
}

async function rectOf(page: Page, selector: string) {
  return page.evaluate((query) => {
    const el = document.querySelector(query);
    if (!el) return null;
    const { x, y, width, height } = el.getBoundingClientRect();
    return { x, y, width, height };
  }, selector);
}

/**
 * Picks an item from the pane's + menu. The menu is placed after it mounts, and in the test's
 * background window that can take a moment, so a click is only made once the item is on screen.
 */
async function pickFromNewTabMenu(page: Page, item: Locator): Promise<void> {
  await page.getByRole('button', { name: 'New tab' }).first().click();
  await expect(item).toBeInViewport();
  await item.click();
}

async function openBrowserTab(page: Page, url: string): Promise<void> {
  await pickFromNewTabMenu(page, page.getByRole('menuitem', { name: /Browser/ }));
  const address = page.getByRole('textbox', { name: 'Open a page' });
  await expect(address).toBeFocused();
  await shot(page, '01-start-page');
  await address.fill(url);
  await address.press('Enter');
  await expect(page.getByRole('tab', { name: /Fixture Shop/ })).toBeVisible();
}

test('a page opens over its pane, keeps its state, and takes comments on its elements', async () => {
  const url = await serve();
  launched = await launchApp({ settings: {} });
  await openWorkspace(launched);
  const { page } = launched;

  await openBrowserTab(page, url);
  await expect
    .poll(() => inGuest<string>(launched as LaunchedApp, 'document.title'))
    .toBe('Fixture Shop');

  // The page sits exactly where the pane body is.
  await expect
    .poll(async () => {
      const slot = await rectOf(page, '[data-browser-slot]');
      const view = await rectOf(page, '#browser-layer webview');
      return slot && view ? Math.abs(slot.x - view.x) + Math.abs(slot.width - view.width) : -1;
    })
    .toBeLessThan(2);
  // And the page's own viewport is that size, so nothing is cut off at the edges.
  const slotWidth = (await rectOf(page, '[data-browser-slot]'))?.width ?? 0;
  await expect
    .poll(() => inGuest<number>(launched as LaunchedApp, 'window.innerWidth'))
    .toBe(Math.round(slotWidth));
  await shot(page, '02-page-loaded');

  // Switching to another tab and back, and splitting the pane, never reloads the page.
  await inGuest(launched, "document.getElementById('buy').click()");
  await pickFromNewTabMenu(
    page,
    page
      .getByRole('menuitem')
      .filter({ hasText: /PowerShell|Command Prompt|bash|zsh/ })
      .first(),
  );
  await expect(page.getByRole('tablist', { name: 'Tabs' }).getByRole('tab')).toHaveCount(2);
  await expect
    .poll(() =>
      page.evaluate(() => {
        const wrapper = document.querySelector('#browser-layer webview')?.parentElement;
        return wrapper ? getComputedStyle(wrapper).visibility : 'none';
      }),
    )
    .toBe('hidden');
  await page.getByRole('tab', { name: /Fixture Shop/ }).click();
  await page.getByRole('button', { name: /Split right/ }).click();
  // The new pane opens its launcher menu; the page stays in the old one.
  await page.keyboard.press('Escape');
  await page.getByRole('tab', { name: /Fixture Shop/ }).click();
  await shot(page, '02b-split');
  await expect
    .poll(() =>
      inGuest<string>(launched as LaunchedApp, "document.getElementById('buy').dataset.clicks"),
    )
    .toBe('1');

  // Comment mode: click the button inside the page.
  await page.getByRole('button', { name: /Comment on an element/ }).click();
  await expect(page.getByText(/Click an element to comment/)).toBeVisible();
  const view = await rectOf(page, '#browser-layer webview');
  const target = await inGuest<{ x: number; y: number; width: number; height: number }>(
    launched,
    "(() => { const r = document.getElementById('buy').getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()",
  );
  if (!view) throw new Error('no webview');
  const at = { x: view.x + target.x + target.width / 2, y: view.y + target.y + target.height / 2 };
  await page.mouse.move(at.x - 20, at.y - 20);
  await page.mouse.move(at.x, at.y, { steps: 5 });
  await expect
    .poll(() =>
      inGuest<string | undefined>(
        launched as LaunchedApp,
        'window.__runovaPicker?.inspect().highlight?.label',
      ),
    )
    .toMatch(/^button\.buy/);
  await shot(page, '03-hover-highlight');
  await page.mouse.click(at.x, at.y);

  const comment = page.getByRole('textbox', { name: 'Comment' });
  await expect(page.getByRole('img', { name: 'Screenshot of the element' })).toBeVisible();
  await comment.fill('Make this button full width on phones');
  await shot(page, '04-comment-card');
  await page.getByRole('button', { name: 'Add comment' }).click();

  // The comment is in the tray, its pin on the page, and its screenshot on disk.
  await expect(page.getByRole('list', { name: 'Comments' }).getByRole('listitem')).toHaveCount(1);
  await expect
    .poll(() =>
      inGuest<number>(
        launched as LaunchedApp,
        'window.__runovaPicker?.inspect().markers.length ?? 0',
      ),
    )
    .toBe(1);
  const pasted = join(launched.userDataDir, 'pasted-images');
  expect(
    existsSync(pasted) && readdirSync(pasted).some((name) => name.startsWith('element-')),
  ).toBe(true);
  await shot(page, '05-tray-and-pin');

  // Picking stops, the pin stays.
  await page.getByRole('button', { name: /Comment on an element/ }).click();
  await expect(page.getByText(/Click an element to comment/)).toHaveCount(0);

  // A phone-sized page.
  await page.getByRole('button', { name: /Device size/ }).click();
  await page.getByRole('menuitemradio', { name: /Mobile/ }).click();
  await expect.poll(() => inGuest<number>(launched as LaunchedApp, 'window.innerWidth')).toBe(390);
  await shot(page, '06-mobile');

  // The same screen in the dark theme.
  await page.evaluate(() => document.documentElement.classList.add('dark'));
  await shot(page, '07-dark');
});
