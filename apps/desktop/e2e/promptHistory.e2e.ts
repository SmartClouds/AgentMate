import { existsSync } from 'node:fs';
import { join } from 'node:path';
import {
  type ElectronApplication,
  _electron as electron,
  expect,
  type Page,
  test,
} from '@playwright/test';
import { type LaunchedApp, launchApp, OS_COLOR_SCHEME } from './app';
import { E2E_OUT_DIR } from './paths';

/**
 * Prompt History is the only feature in the suite that goes through better-sqlite3, whose native
 * binding is compiled against one exact Electron ABI (see promptHistoryDb.ts and the
 * `rebuild:native` script). If that rebuild is ever missed, every call here throws, so this spec
 * is also how the suite notices. Everything below runs against the real database file in the
 * test's own profile, restart included.
 */

const ALPHA = 'sqlite marker alpha';
const BRAVO = 'sqlite marker bravo';
const CHARLIE = 'sqlite marker charlie';

let launched: LaunchedApp | undefined;
let relaunched: ElectronApplication | undefined;

test.afterEach(async () => {
  await relaunched?.close().catch(() => undefined);
  relaunched = undefined;
  await launched?.close();
  launched = undefined;
});

interface HistoryApi {
  runova: {
    promptHistory: {
      add(input: unknown): Promise<{ id: string }>;
      list(): Promise<{ id: string; content: string }[]>;
    };
  };
}

async function seed(page: Page): Promise<void> {
  await page.evaluate(
    async ([alpha, bravo, charlie]) => {
      const history = (window as unknown as HistoryApi).runova.promptHistory;
      await history.add({
        rawInput: 'alpha request',
        promptType: 'Feature',
        targetAI: 'Claude',
        content: alpha,
        source: 'generate',
      });
      await history.add({
        rawInput: 'bravo request',
        promptType: 'Bugfix',
        targetAI: 'Codex',
        content: bravo,
        source: 'generate',
      });
      await history.add({
        rawInput: 'charlie request',
        promptType: '',
        targetAI: '',
        content: charlie,
        source: 'translate',
      });
    },
    [ALPHA, BRAVO, CHARLIE],
  );
}

function contentsOnDisk(page: Page): Promise<string[]> {
  return page.evaluate(async () => {
    const entries = await (window as unknown as HistoryApi).runova.promptHistory.list();
    return entries.map((entry) => entry.content);
  });
}

async function openHistory(page: Page): Promise<void> {
  await page.evaluate(() => {
    window.location.hash = '#/prompt-history';
  });
  await expect(page.getByPlaceholder('Search prompt history…')).toBeVisible();
}

/** Stops the app and starts a new one on the same profile, so the database is reopened. */
async function relaunch(current: LaunchedApp): Promise<Page> {
  const exited = new Promise<void>((resolve) =>
    current.app.process().once('exit', () => resolve()),
  );
  await current.app.evaluate(({ app }) => app.exit(0)).catch(() => undefined);
  await Promise.race([exited, new Promise((resolve) => setTimeout(resolve, 10_000))]);

  relaunched = await electron.launch({
    ...OS_COLOR_SCHEME,
    args: [
      join(E2E_OUT_DIR, 'main', 'index.mjs'),
      `--user-data-dir=${current.userDataDir}`,
      ...(process.env.RUNOVA_E2E_NO_SANDBOX === '1' ? ['--no-sandbox'] : []),
    ],
    env: {
      ...(process.env as Record<string, string>),
      ELECTRON_RENDERER_URL: '',
      RUNOVA_USER_DATA_DIR: current.userDataDir,
      RUNOVA_E2E: '1',
    },
  });
  const page = await relaunched.firstWindow();
  await page.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  return page;
}

test('entries are listed, searched, deleted, and what is left survives a restart', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;

  await seed(page);
  await openHistory(page);

  const cards = page.getByRole('button', { name: 'View details' });
  await expect(cards).toHaveCount(3);
  await expect(page.getByText(ALPHA)).toBeVisible();
  await expect(page.getByText(CHARLIE)).toBeVisible();
  // A translated entry is labelled as one, a generated entry carries its type and target.
  await expect(page.getByRole('heading', { name: 'Translation' })).toBeVisible();
  await expect(page.getByRole('heading', { name: 'Feature' })).toBeVisible();

  // The search box drives a query per keystroke, so give the result a moment to land.
  const search = page.getByPlaceholder('Search prompt history…');
  await search.fill('bravo');
  await expect(cards).toHaveCount(1);
  await expect(page.getByText(BRAVO)).toBeVisible();
  await expect(page.getByText(ALPHA)).toHaveCount(0);

  // Searching by prompt type works too: the database looks at more than the content.
  await search.fill('Codex');
  await expect(cards).toHaveCount(1);
  await expect(page.getByText(BRAVO)).toBeVisible();

  await search.fill('alpha');
  await expect(cards).toHaveCount(1);
  await page.getByRole('button', { name: 'Delete' }).click();
  const confirm = page.getByRole('dialog', { name: 'Delete this prompt history entry?' });
  await expect(confirm).toBeVisible();
  await confirm.getByRole('button', { name: 'Delete' }).click();

  await expect(page.getByText('No matching prompts found.')).toBeVisible();
  await search.fill('');
  await expect(cards).toHaveCount(2);
  await expect.poll(() => contentsOnDisk(page)).toEqual([CHARLIE, BRAVO]);

  const page2 = await relaunch(current);
  await openHistory(page2);
  await expect(page2.getByRole('button', { name: 'View details' })).toHaveCount(2);
  await expect(page2.getByText(BRAVO)).toBeVisible();
  await expect(page2.getByText(CHARLIE)).toBeVisible();
  await expect(page2.getByText(ALPHA)).toHaveCount(0);

  // The database really is a file in this run's profile and nowhere else.
  expect(existsSync(join(current.userDataDir, 'data', 'prompt-history.db'))).toBe(true);
});

test('an empty history says so', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;

  await openHistory(page);
  await expect(page.getByText('Nothing here yet')).toBeVisible();
  await expect(page.getByRole('button', { name: 'View details' })).toHaveCount(0);
});
