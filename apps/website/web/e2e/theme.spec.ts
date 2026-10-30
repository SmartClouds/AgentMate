import { expect, type Page, test } from '@playwright/test';

const html = (page: Page) => page.locator('html');
const toggle = (page: Page) => page.getByRole('button', { name: /Switch to (light|dark) theme/ });

/** Opens the home page with a system color scheme and waits until the toggle island hydrates. */
async function open(page: Page, colorScheme: 'dark' | 'light') {
  await page.emulateMedia({ colorScheme });
  await page.goto('/');
  await page.locator('astro-island:not([ssr])').first().waitFor({ state: 'attached' });
}

test.describe('theme', () => {
  test('starts in Dark when the system prefers dark', async ({ page }) => {
    await open(page, 'dark');
    await expect(html(page)).toHaveClass(/\bdark\b/);
  });

  test('follows a light system preference on the first visit', async ({ page }) => {
    await open(page, 'light');
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await expect(toggle(page)).toHaveAccessibleName('Switch to dark theme');
  });

  test('the toggle switches the theme and remembers the choice', async ({ page }) => {
    await open(page, 'dark');
    await expect(toggle(page)).toHaveAccessibleName('Switch to light theme');

    await toggle(page).click();
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    expect(await page.evaluate(() => localStorage.getItem('runova-theme'))).toBe('light');

    await page.reload();
    await page.locator('astro-island:not([ssr])').first().waitFor({ state: 'attached' });
    await expect(html(page)).not.toHaveClass(/\bdark\b/);
    await expect(toggle(page)).toHaveAccessibleName('Switch to dark theme');

    await toggle(page).click();
    await expect(html(page)).toHaveClass(/\bdark\b/);
    expect(await page.evaluate(() => localStorage.getItem('runova-theme'))).toBe('dark');
  });

  test('the background follows the theme tokens', async ({ page }) => {
    await open(page, 'dark');
    const background = () => page.evaluate(() => getComputedStyle(document.body).backgroundColor);
    expect(await background()).toBe('rgb(10, 10, 10)');
    await toggle(page).click();
    await expect.poll(background).toBe('rgb(245, 245, 245)');
  });
});

// Chromium reports a light scheme when emulating `no-preference`, so the default shows where no
// script runs: the server render is Dark.
test.describe('without JavaScript', () => {
  test.use({ javaScriptEnabled: false, colorScheme: 'light' });

  test('the page is Dark by default', async ({ page }) => {
    await page.goto('/');
    await expect(html(page)).toHaveClass(/\bdark\b/);
  });
});

/** Every element and pseudo-element whose computed style still animates or transitions. */
function moving(page: Page) {
  return page.evaluate(() => {
    const seconds = (value: string) =>
      Math.max(...value.split(',').map((part) => Number.parseFloat(part) || 0));
    const found: string[] = [];
    for (const element of document.querySelectorAll('*')) {
      for (const pseudo of [null, '::before', '::after']) {
        const style = getComputedStyle(element, pseudo);
        const animates = style.animationName !== 'none' && seconds(style.animationDuration) > 0;
        const transitions =
          style.transitionProperty !== 'none' && seconds(style.transitionDuration) > 0;
        if (animates || transitions) found.push(`${element.tagName}${pseudo ?? ''}`);
      }
    }
    return found;
  });
}

test.describe('reduced motion', () => {
  test('nothing animates or transitions when the visitor asks for less motion', async ({
    page,
  }) => {
    await page.emulateMedia({ reducedMotion: 'reduce' });
    await page.goto('/');
    expect(await moving(page)).toEqual([]);
    expect(
      await page.evaluate(() => getComputedStyle(document.documentElement).scrollBehavior),
    ).toBe('auto');
  });

  test('the same page does have transitions without the preference', async ({ page }) => {
    await page.emulateMedia({ reducedMotion: 'no-preference' });
    await page.goto('/');
    expect((await moving(page)).length).toBeGreaterThan(0);
  });
});
