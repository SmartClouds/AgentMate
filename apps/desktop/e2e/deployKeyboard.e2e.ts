import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type DevHost, dotnetAvailable, startDevHost } from './devHost';

/**
 * Every Deploy screen by keyboard alone (E17 AC2), against the DevHost: each server section is
 * opened from the section strip with Tab and Enter, the next Tab lands on a control inside it, and
 * that control shows a focus ring. The Security tabs are switched with the arrow keys. Every
 * button on each screen has a name a screen reader can read. Checked through the DOM, since this
 * machine's screenshots of the e2e window can be stale.
 */

test.skip(!dotnetAvailable(), 'needs the .NET SDK to build the server core DevHost');

const DEV_PASSWORD = 'runova-local-password';
const SECTIONS = [
  'Overview',
  'Apps',
  'Containers',
  'Files',
  'App Store',
  'Websites',
  'Firewall',
  'Logs',
  'Backups',
  'Security',
  'Notifications',
];
const SECURITY_TABS = [
  'Checklist',
  'Users',
  'Devices and sessions',
  'Audit trail',
  'Backups',
  'Error reporting',
  'Connection',
];

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

/** Where focus is: inside the open section (after the strip), and whether it shows a ring. */
function focusState(page: Page) {
  return page.evaluate(() => {
    const nav = document.querySelector('nav[aria-label="Server sections"]');
    const active = document.activeElement as HTMLElement | null;
    if (!nav || !active || active === document.body) return { where: 'nowhere', ring: false };
    const column = nav.parentElement;
    const inSection =
      !!column?.contains(active) &&
      !nav.contains(active) &&
      !!(nav.compareDocumentPosition(active) & Node.DOCUMENT_POSITION_FOLLOWING);
    const drawsRing = (node: Element) => {
      const style = getComputedStyle(node);
      return (
        (style.outlineStyle !== 'none' && Number.parseFloat(style.outlineWidth) > 0) ||
        style.boxShadow !== 'none'
      );
    };
    // A search box has no outline of its own, it draws the ring on the pill around the input.
    const pill = active.matches('input') ? active.closest('.search-pill') : null;
    const ring = drawsRing(active) || (!!pill && drawsRing(pill));
    return { where: nav.contains(active) ? 'strip' : inSection ? 'section' : 'elsewhere', ring };
  });
}

/** Buttons on the page with no name: no text, no aria-label and nothing labelling them. */
function unnamedButtons(page: Page) {
  return page.evaluate(() =>
    [...document.querySelectorAll('main button, main [role="button"], main [role="tab"]')]
      .filter((element) => {
        const box = element.getBoundingClientRect();
        if (box.width === 0 || box.height === 0) return false;
        const labelledBy = element.getAttribute('aria-labelledby');
        const name =
          element.getAttribute('aria-label') ||
          (labelledBy && document.getElementById(labelledBy)?.textContent) ||
          (element as HTMLElement).innerText;
        return !name?.trim();
      })
      .map((element) => element.outerHTML.slice(0, 160)),
  );
}

/** Tabs forward until focus leaves the section strip, and says where it went. */
async function tabIntoSection(page: Page) {
  for (let step = 0; step < SECTIONS.length + 2; step += 1) {
    await page.keyboard.press('Tab');
    const state = await focusState(page);
    if (state.where !== 'strip') return state;
  }
  return focusState(page);
}

test('reaches and operates every Deploy screen by keyboard alone', async () => {
  test.setTimeout(300_000);
  if (!devHost) throw new Error('DevHost did not start');
  launched = await launchApp({
    settings: {},
    env: { RUNOVA_DEPLOY_DEV_CORE: String(devHost.port) },
  });
  const { page } = launched;

  await page.getByRole('link', { name: 'Deploy' }).click();
  await expect(page.getByText('Sign in to manage this core.')).toBeVisible({ timeout: 30_000 });
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  const signIn = page.getByRole('dialog', { name: 'Sign in to DevHost' });
  await signIn.getByLabel('Password', { exact: true }).fill(DEV_PASSWORD);
  await signIn.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByText(/Signed in as/)).toBeVisible();

  const strip = page.getByRole('navigation', { name: 'Server sections' });
  for (const [index, section] of SECTIONS.entries()) {
    // From the first section's button, Tab along the strip to this one and press Enter.
    // Shift+Tab and back puts the browser in keyboard mode, as a person tabbing in would.
    await strip.getByRole('button', { name: SECTIONS[0], exact: true }).focus();
    await page.keyboard.press('Shift+Tab');
    await page.keyboard.press('Tab');
    for (let step = 0; step < index; step += 1) await page.keyboard.press('Tab');
    const button = strip.getByRole('button', { name: section, exact: true });
    await expect(button).toBeFocused();
    expect((await focusState(page)).ring, `${section} in the strip shows focus`).toBe(true);
    await page.keyboard.press('Enter');
    await expect(button).toHaveAttribute('aria-current', 'page');
    // Each screen has something to act on once it has loaded.
    await page.waitForTimeout(1_500);

    const state = await tabIntoSection(page);
    expect(state.where, `Tab after ${section} lands inside it`).toBe('section');
    expect(state.ring, `the first control in ${section} shows focus`).toBe(true);
    expect(await unnamedButtons(page), `buttons without a name on ${section}`).toEqual([]);
  }

  // The Security tabs: the arrow keys move between them, Tab goes into the open one. Security is
  // not the last section any more, so open it again first.
  const security = strip.getByRole('button', { name: 'Security', exact: true });
  await security.focus();
  await page.keyboard.press('Enter');
  await expect(security).toHaveAttribute('aria-current', 'page');
  const first = page.getByRole('tab', { name: SECURITY_TABS[0] });
  await first.focus();
  for (const [index, name] of SECURITY_TABS.entries()) {
    if (index > 0) await page.keyboard.press('ArrowRight');
    const tab = page.getByRole('tab', { name });
    await expect(tab).toBeFocused();
    await expect(tab).toHaveAttribute('aria-selected', 'true');
    expect((await focusState(page)).ring, `the ${name} tab shows focus`).toBe(true);
    await page.keyboard.press('Tab');
    const state = await focusState(page);
    expect(state.where, `Tab after the ${name} tab stays in Security`).toBe('section');
    expect(state.ring, `focus inside ${name} shows`).toBe(true);
    expect(await unnamedButtons(page), `buttons without a name on ${name}`).toEqual([]);
    await tab.focus();
  }
});
