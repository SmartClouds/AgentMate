import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * Switching workspaces has to stay quick while a big test suite runs in the Tests tab. A suite of a
 * few thousand tests that logs as it goes used to keep both the main process and the window busy
 * for seconds at a time: the main process trimmed the whole kept output on every line and sent two
 * messages per test, and the window copied every result and redrew every row for each of them.
 * Clicking another project then took seconds to land.
 *
 * The project's `node_modules/.bin/vitest` is a Node script that streams Vitest's verbose output
 * for 400 files of 8 tests in bursts, with log lines in between, and keeps going until
 * `finish.flag` appears.
 */

const FILES = 400;
const TESTS_PER_FILE = 8;

const FAKE_VITEST = `
const fs = require('node:fs');
const path = require('node:path');
const args = process.argv.slice(2);
const out = (args.find((a) => a.startsWith('--outputFile.json=')) || '').slice('--outputFile.json='.length);
const FILES = ${FILES};
const TESTS = ${TESTS_PER_FILE};
const BURST = 8;
const finishFlag = path.join(process.cwd(), 'finish.flag');
const report = [];
let file = 0;
let tick = 0;
console.log(' RUN  v9.9.9 fake vitest');

function emitFile() {
  const name = 'src/f' + file + '.test.ts';
  const lines = [];
  const assertionResults = [];
  for (let t = 0; t < TESTS; t += 1) {
    lines.push('stdout | ' + name + ' > suite > t' + t);
    for (let n = 0; n < 5; n += 1) lines.push('  some log line the test printed ' + n + ' ' + 'x'.repeat(60));
    lines.push(' \\u2713 ' + name + ' > suite > t' + t + ' 3ms');
    assertionResults.push({ ancestorTitles: ['suite'], title: 't' + t, status: 'passed', duration: 3, failureMessages: [] });
  }
  report.push({ name: path.join(process.cwd(), name), status: 'passed', message: '', assertionResults });
  file += 1;
  return lines.join('\\n') + '\\n';
}

function step() {
  tick += 1;
  if (fs.existsSync(finishFlag)) {
    let rest = '';
    while (file < FILES) rest += emitFile();
    process.stdout.write(rest);
    fs.writeFileSync(out, JSON.stringify({ testResults: report }));
    return;
  }
  // Parallel workers finish several files at once, so output comes in bursts. The last file is
  // held back: a test that keeps logging until the flag shows up.
  let burst = '';
  for (let i = 0; i < BURST && file < FILES - 1; i += 1) burst += emitFile();
  process.stdout.write(burst || '  still logging ' + tick + ' ' + 'y'.repeat(60) + '\\n');
  setTimeout(step, 200);
}
step();
`;

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  await launched?.close();
  launched = undefined;
});

function write(root: string, path: string, content: string): void {
  const full = join(root, path);
  mkdirSync(dirname(full), { recursive: true });
  writeFileSync(full, content);
}

function seedBigVitestProject(projectDir: string): void {
  write(
    projectDir,
    'package.json',
    JSON.stringify({ name: 'big', devDependencies: { vitest: '5' } }),
  );
  for (let f = 0; f < FILES; f += 1) {
    const tests = Array.from({ length: TESTS_PER_FILE }, (_, t) => `  it('t${t}', () => {});`);
    write(projectDir, `src/f${f}.test.ts`, `describe('suite', () => {\n${tests.join('\n')}\n});\n`);
  }
  write(projectDir, 'fake-vitest.js', FAKE_VITEST);
  if (process.platform === 'win32') {
    write(
      projectDir,
      'node_modules/.bin/vitest.cmd',
      '@node "%~dp0\\..\\..\\fake-vitest.js" %*\r\n',
    );
  } else {
    write(
      projectDir,
      'node_modules/.bin/vitest',
      '#!/bin/sh\nexec node "$(dirname "$0")/../../fake-vitest.js" "$@"\n',
    );
    chmodSync(join(projectDir, 'node_modules/.bin/vitest'), 0o755);
  }
}

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

interface Ready {
  selector: string;
  text: string;
}

/** The big project's panel is up once its first test file shows in the tree. */
const BIG_READY: Ready = { selector: '[data-test-name]', text: 'src/f0.test.ts' };
/** The other project has no tests, which its panel says. */
const OTHER_READY: Ready = { selector: 'p', text: 'No tests found' };

/**
 * Clicks a project on the rail and returns how long, in milliseconds, until its panel shows
 * `ready`. It is timed inside the window: waiting from the test side would add the back-off
 * between Playwright's checks, which grows to a second each.
 */
async function switchTo(page: Page, name: string, ready: Ready): Promise<number> {
  const label = `Open ${name}`;
  await expect(page.getByRole('button', { name: label, exact: true })).toBeVisible();
  const elapsed = await page.evaluate(
    async ({ label, ready }) => {
      const button = document.querySelector<HTMLButtonElement>(`button[aria-label="${label}"]`);
      if (!button) throw new Error(`No "${label}" button on the rail`);
      const shown = (): boolean =>
        Array.from(document.querySelectorAll<HTMLElement>(ready.selector)).some(
          (element) => element.textContent === ready.text && element.checkVisibility(),
        );
      // A message turn rather than a frame or a timer: a test window sits in the background,
      // where Chromium holds those to about one a second. React schedules its work this way too.
      const turn = (): Promise<void> =>
        new Promise((resolve) => {
          const channel = new MessageChannel();
          channel.port1.onmessage = () => resolve();
          channel.port2.postMessage(null);
        });
      const started = performance.now();
      button.click();
      const deadline = started + 30_000;
      while (!shown()) {
        if (performance.now() > deadline) throw new Error(`"${ready.text}" never showed`);
        await turn();
      }
      return performance.now() - started;
    },
    { label, ready },
  );
  await expect(page.getByRole('button', { name: label, exact: true })).toHaveAttribute(
    'aria-current',
    'page',
  );
  return Math.round(elapsed);
}

test('switching workspaces stays quick while a big test suite streams its results', async () => {
  test.setTimeout(240_000);
  launched = await launchApp({ settings: { defaultCliId: 'claude-code' } });
  const { app, page, projectDir, root } = launched;
  seedBigVitestProject(projectDir);
  const otherDir = join(root, 'other');
  write(otherDir, 'README.md', '# nothing to test\n');

  const bigId = await createProject(page, 'big suite', projectDir);
  const otherId = await createProject(page, 'other project', otherDir);
  // Projects made through IPC are not in the cached list yet, so reload onto the first one.
  await page.evaluate((id) => {
    location.hash = `#/workspace/${id}`;
  }, otherId);
  await page.reload();
  await page.evaluate((id) => {
    location.hash = `#/workspace/${id}`;
  }, bigId);

  const tab = page.getByRole('tab', { name: 'Tests' });
  await expect(tab).toBeVisible({ timeout: 60_000 });
  await tab.click();
  await expect(page.locator(BIG_READY.selector, { hasText: BIG_READY.text }).first()).toBeVisible({
    timeout: 60_000,
  });
  // Both panels get their tests discovered once before anything is timed. Then a baseline with
  // nothing running, so a slow switch under load can be told apart from a slow switch.
  await switchTo(page, 'other project', OTHER_READY);
  await switchTo(page, 'big suite', BIG_READY);
  const idleSwitches: number[] = [];
  for (let round = 0; round < 2; round += 1) {
    idleSwitches.push(await switchTo(page, 'other project', OTHER_READY));
    idleSwitches.push(await switchTo(page, 'big suite', BIG_READY));
  }

  // How long the main process and the window go without getting to anything else.
  await app.evaluate(() => {
    const state = globalThis as unknown as { mainLagMs: number };
    state.mainLagMs = 0;
    let last = Date.now();
    setInterval(() => {
      const now = Date.now();
      state.mainLagMs = Math.max(state.mainLagMs, now - last - 50);
      last = now;
    }, 50);
  });
  await page.evaluate(() => {
    const state = window as unknown as { longestTaskMs: number };
    state.longestTaskMs = 0;
    new PerformanceObserver((list) => {
      for (const entry of list.getEntries()) {
        state.longestTaskMs = Math.max(state.longestTaskMs, entry.duration);
      }
    }).observe({ type: 'longtask', buffered: false });
  });

  await page.getByRole('button', { name: 'Run all tests' }).click();
  await expect(page.getByText(/Running \d+ tests/)).toBeVisible({ timeout: 30_000 });
  // Let the run get properly going, with results and output pouring in.
  await expect(page.getByText(/^\d+ passed$/)).toBeVisible({ timeout: 30_000 });

  const switches: number[] = [];
  for (let round = 0; round < 3; round += 1) {
    switches.push(await switchTo(page, 'other project', OTHER_READY));
    switches.push(await switchTo(page, 'big suite', BIG_READY));
  }
  // Every switch above has to have happened under load, or the numbers mean nothing.
  await expect(page.getByText(/Running \d+ tests/)).toBeVisible();

  const mainLagMs = await app.evaluate(
    () => (globalThis as unknown as { mainLagMs: number }).mainLagMs,
  );
  const longestTaskMs = await page.evaluate(
    () => (window as unknown as { longestTaskMs: number }).longestTaskMs,
  );
  const metrics = {
    idleSwitches,
    switches,
    slowest: Math.max(...switches),
    mainLagMs,
    longestTaskMs,
  };
  test.info().annotations.push({ type: 'metrics', description: JSON.stringify(metrics) });
  // biome-ignore lint/suspicious/noConsole: the numbers are the point when this gets close to failing
  console.log('workspace switch under load', metrics);

  writeFileSync(join(projectDir, 'finish.flag'), '');
  await expect(page.getByText(`${FILES * TESTS_PER_FILE} passed`, { exact: true })).toBeVisible({
    timeout: 60_000,
  });

  // Measured on a fast Windows machine: before the fix, 1,000 to 1,500 ms per switch to the big
  // project with window tasks as long, and the main process stalling up to about 350 ms. After it,
  // about 70 to 220 ms, 90 to 140 ms and 15 to 25 ms. The limits leave room for slower CI machines.
  expect(metrics.slowest, 'slowest project switch (ms)').toBeLessThan(750);
  expect(metrics.longestTaskMs, 'longest window task (ms)').toBeLessThan(500);
  expect(metrics.mainLagMs, 'longest main process stall (ms)').toBeLessThan(300);
});
