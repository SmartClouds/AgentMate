import { expect, type Page, test } from '@playwright/test';
import { closeApp, type LaunchedApp, launchApp } from './app';
import {
  AI_NEWS,
  type FakeNewsServer,
  OTHER_FIX,
  RELEASE,
  RUNOVA_FIX,
  startFakeNews,
} from './fakeNewsServer';

/**
 * The news card (E42) against a fake website API on loopback: the items show, the category filter
 * narrows them, an item opens in the detail sheet and stays read after a restart, the critical
 * fix for Runova itself carries the affected badge and raises exactly one notification, and
 * turning news off in Settings takes the card away.
 */

let news: FakeNewsServer | undefined;
const opened: LaunchedApp[] = [];

test.afterEach(async () => {
  // The latest first: a restarted app runs on the folder the first one deletes when it closes.
  for (const launched of opened.splice(0).reverse()) await launched.close();
  await news?.close();
  news = undefined;
});

function launch(apiUrl: string, reuseRoot?: string): Promise<LaunchedApp> {
  return launchApp({ env: { RUNOVA_NEWS_API_URL: apiUrl }, reuseRoot }).then((launched) => {
    opened.push(launched);
    return launched;
  });
}

async function openDashboard(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/';
  });
}

function newsList(page: Page) {
  return page.getByRole('list', { name: 'News', exact: true });
}

function row(page: Page, title: string) {
  return newsList(page).getByRole('button', { name: title });
}

/** The news entries in the app's inbox. */
function securityNotifications(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const api = (
      window as unknown as {
        runova: { appNotifications: { list(): Promise<{ id: string; kind: string }[]> } };
      }
    ).runova;
    return (await api.appNotifications.list())
      .filter((item) => item.kind === 'news-security')
      .map((item) => item.id);
  });
}

test('news shows, filters, opens, stays read after a restart and notifies once', async () => {
  test.setTimeout(180_000);
  news = await startFakeNews();
  const fake = news;
  const first = await launch(fake.apiUrl);
  const { page } = first;

  await openDashboard(page);
  // The first poll waits 30 seconds after startup, so the card's own button asks now.
  await page.getByRole('button', { name: 'Check for news now' }).click();
  for (const item of [RUNOVA_FIX, OTHER_FIX, RELEASE, AI_NEWS]) {
    await expect(row(page, item.title)).toBeVisible({ timeout: 20_000 });
  }

  // Runova itself is installed, at whatever version this is, so the critical fix matches it.
  // PHP is not something the app can see here, so its fix carries no badge.
  await expect(row(page, RUNOVA_FIX.title)).toContainText('Affects your system: Runova');
  await expect(row(page, OTHER_FIX.title)).not.toContainText('Affects your system');

  // One notification for the one matched critical item, and another check adds none.
  await expect
    .poll(() => securityNotifications(page), { timeout: 20_000 })
    .toEqual([`news:${RUNOVA_FIX.id}`]);
  await page.getByRole('button', { name: 'Check for news now' }).click();
  await expect.poll(() => fake.requestsTo('/api/v1/news').length).toBeGreaterThanOrEqual(2);
  await expect.poll(() => securityNotifications(page)).toEqual([`news:${RUNOVA_FIX.id}`]);

  // The category filter narrows the card to release news, and Show all brings the rest back.
  await page.getByRole('button', { name: 'All categories' }).click();
  await page.getByRole('menuitemcheckbox', { name: 'Release' }).click();
  await page.keyboard.press('Escape');
  await expect(row(page, RELEASE.title)).toBeVisible();
  await expect(row(page, RUNOVA_FIX.title)).toHaveCount(0);
  await expect(row(page, AI_NEWS.title)).toHaveCount(0);
  await page.getByRole('button', { name: 'Release', exact: true }).click();
  await page.getByRole('menuitem', { name: 'Show all categories' }).click();
  await expect(row(page, AI_NEWS.title)).toBeVisible();

  // Opening an item shows it in full and reads it.
  await expect(row(page, RELEASE.title).getByRole('img', { name: 'Unread' })).toBeVisible();
  await row(page, RELEASE.title).click();
  const sheet = page.getByRole('dialog');
  await expect(sheet.getByRole('heading', { name: RELEASE.title })).toBeVisible();
  await expect(sheet.getByText('Update as soon as you can.')).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Advisory' })).toBeVisible();
  await expect(sheet.getByRole('button', { name: 'Read', exact: true })).toBeDisabled();
  await page.keyboard.press('Escape');
  await expect(sheet).toHaveCount(0);
  await expect(row(page, RELEASE.title).getByRole('img', { name: 'Unread' })).toHaveCount(0);
  expect(fake.requestsTo(`/api/v1/news/${RELEASE.slug}`).length).toBeGreaterThan(0);

  // Nothing about the user goes to the API: no cookie, only the app version in the User-Agent.
  for (const request of fake.requests) {
    expect(request.cookie).toBeNull();
    expect(request.userAgent).toMatch(/^Runova\/\S+ \(\w+\)$/);
  }

  // After a restart the cached items show before any check, and what was read stays read.
  await closeApp(first.app, first.root);
  const second = await launch(fake.apiUrl, first.root);
  await openDashboard(second.page);
  await expect(row(second.page, RELEASE.title)).toBeVisible({ timeout: 20_000 });
  await expect(row(second.page, RELEASE.title).getByRole('img', { name: 'Unread' })).toHaveCount(0);
  await expect(
    row(second.page, RUNOVA_FIX.title).getByRole('img', { name: 'Unread' }),
  ).toBeVisible();
  await second.page.getByRole('button', { name: 'Check for news now' }).click();
  await expect.poll(() => securityNotifications(second.page)).toEqual([`news:${RUNOVA_FIX.id}`]);

  // Turning news off in Settings takes the card off the Dashboard and is saved.
  await second.page.evaluate(() => {
    window.location.hash = '#/settings?tab=notifications';
  });
  const showNews = second.page.getByRole('switch', { name: 'Show news' });
  await expect(showNews).toBeChecked();
  await showNews.click();
  await expect.poll(() => second.settingsOnDisk().newsEnabled).toBe(false);
  await openDashboard(second.page);
  await expect(second.page.getByRole('button', { name: 'Check for news now' })).toHaveCount(0);
  await expect(newsList(second.page)).toHaveCount(0);
});
