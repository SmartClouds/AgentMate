import { execFileSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { rmSync } from 'node:fs';
import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';

/**
 * The terminal drawer against the real pty host: a shell is started, a command typed into it
 * comes back out, a second tab is its own shell, closing tabs ends those shells, and a quit with
 * nothing left open takes the background host with it.
 *
 * Output is read from `window.runova.terminal.onData` rather than from the xterm DOM: xterm
 * renders to a canvas-backed grid where a line can be wrapped, redrawn or scrolled out from under
 * a poll, while the data stream is exactly what main sent the renderer.
 */

/** A shell writes the command back as it is typed, so the marker is assembled by the shell. */
function marker(): { command: string; expected: string } {
  const id = randomBytes(6).toString('hex');
  return { command: `echo runova-"e2e"-${id}`, expected: `runova-e2e-${id}` };
}

interface TerminalApi {
  runova: {
    terminal: {
      write(sessionId: string, data: string): Promise<void>;
      usage(): Promise<{ sessions: { sessionId: string; pid: number; surface?: string }[] }>;
      onData(callback: (payload: { sessionId: string; data: string }) => void): () => void;
    };
  };
  __e2eTerminalOutput?: Record<string, string>;
}

let launched: LaunchedApp | undefined;

test.afterEach(async () => {
  const current = launched;
  launched = undefined;
  if (!current) return;
  try {
    await current.close();
  } catch {
    // The quit test lets the app exit on its own, after which Playwright has already let go of
    // it and close() cannot reach it. Its temp folder still has to go.
    rmSync(current.root, { recursive: true, force: true, maxRetries: 10, retryDelay: 500 });
  }
});

/** Collects everything every shell sends, keyed by session, for the rest of the page's life. */
async function captureOutput(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as TerminalApi;
    if (target.__e2eTerminalOutput) return;
    target.__e2eTerminalOutput = {};
    target.runova.terminal.onData(({ sessionId, data }) => {
      const store = target.__e2eTerminalOutput!;
      store[sessionId] = (store[sessionId] ?? '') + data;
    });
  });
}

function outputFor(page: Page, sessionId: string): Promise<string> {
  return page.evaluate(
    (id) => (window as unknown as TerminalApi).__e2eTerminalOutput?.[id] ?? '',
    sessionId,
  );
}

function drawerSessions(
  page: Page,
): Promise<{ sessionId: string; pid: number; surface?: string }[]> {
  return page.evaluate(async () => {
    const usage = await (window as unknown as TerminalApi).runova.terminal.usage();
    return usage.sessions.filter((session) => session.surface !== 'workspace');
  });
}

/**
 * Presses the toggle until the drawer is up. The shell binds the shortcut in an effect, so a
 * press fired in the first moments after launch can land before the listener exists.
 */
async function openDrawer(page: Page): Promise<void> {
  await expect(page.getByRole('link', { name: 'Dashboard' })).toBeVisible();
  const emptyState = page.getByText('Open a terminal');
  await expect(async () => {
    await page.keyboard.press('Control+T');
    await expect(emptyState).toBeVisible({ timeout: 3_000 });
  }).toPass({ timeout: 30_000 });
}

/** True while a process with this pid is still around. */
function pidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
}

/**
 * Processes whose command line mentions this run's temp folder: the app, the terminal host and
 * the shells under it. The lookup itself carries that folder in its own command line, so it is
 * left out of its own answer.
 */
function processesUnder(root: string): number {
  if (process.platform === 'win32') {
    const needle = root.replace(/'/g, "''");
    const out = execFileSync(
      'powershell',
      [
        '-NoProfile',
        '-Command',
        `Get-CimInstance Win32_Process | Where-Object { $_.CommandLine -like '*${needle}*' } | ForEach-Object { $_.CommandLine -replace '\\s+', ' ' }`,
      ],
      { encoding: 'utf-8' },
    );
    return out
      .split('\n')
      .map((line) => line.trim())
      .filter((line) => line.length > 0 && !line.includes('Win32_Process')).length;
  }
  try {
    // execFileSync, so no shell of our own shows up carrying the pattern.
    const out = execFileSync('pgrep', ['-f', root], { encoding: 'utf-8' });
    return out.split('\n').filter(Boolean).length;
  } catch {
    // pgrep exits non-zero when nothing matched.
    return 0;
  }
}

test('a shell runs a command, a second tab is its own, and closing tabs ends both', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page } = current;
  await captureOutput(page);
  await openDrawer(page);

  // The drawer opens empty; a tab is a separate act.
  expect(await drawerSessions(page)).toEqual([]);
  // Exact: the tab-strip icon button ("New Terminal (shortcut…)") matches the prefix too.
  await page.getByRole('button', { name: 'New Terminal', exact: true }).click();

  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(1);
  const [first] = await drawerSessions(page);
  expect(first.pid).toBeGreaterThan(0);

  const { command, expected } = marker();
  await page.evaluate(
    ({ id, text }) => (window as unknown as TerminalApi).runova.terminal.write(id, `${text}\r`),
    { id: first.sessionId, text: command },
  );
  // The shell has to start, read the line and answer, which is slow on a cold Windows profile.
  await expect
    .poll(() => outputFor(page, first.sessionId), { timeout: 90_000 })
    .toContain(expected);

  // A second tab gets its own shell, not a second view of the first.
  await page
    .getByRole('button', { name: /^New Terminal/ })
    .first()
    .click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(2);
  const sessions = await drawerSessions(page);
  const pids = sessions.map((session) => session.pid);
  expect(new Set(pids).size).toBe(2);

  const tabs = page.getByRole('tablist', { name: 'Terminal sessions' });
  await expect(tabs.getByRole('tab')).toHaveCount(2);

  // Closing a tab ends its shell rather than only hiding the tab. Each click re-renders the
  // strip, so the next one is looked up again rather than held from before.
  const closeButtons = tabs.getByRole('button', { name: /^Close / });
  await expect(closeButtons).toHaveCount(2);
  await closeButtons.first().click();
  await expect(closeButtons).toHaveCount(1);
  await closeButtons.first().click();
  await expect(tabs.getByRole('tab')).toHaveCount(0);
  await expect(page.getByText('Open a terminal')).toBeVisible();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toEqual([]);
  await expect.poll(() => pids.filter(pidAlive), { timeout: 60_000 }).toEqual([]);
});

test('one click anywhere on a tab switches to it while typing in another', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  await openDrawer(page);

  const newTab = page.getByRole('button', { name: /^New Terminal/ }).first();
  await newTab.click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(1);
  await newTab.click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(2);
  const tabs = page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');
  await expect(tabs).toHaveCount(2);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');

  // Each press lands on a different part of the tab: the padding at either edge (which once did
  // nothing, so switching took a second click) and the label. The terminal holds the keyboard
  // every time, the way it does while someone is typing in it.
  const spots = [
    (box: { x: number; width: number }) => box.x + 3,
    (box: { x: number; width: number }) => box.x + box.width - 3,
    (box: { x: number; width: number }) => box.x + box.width / 2,
  ];
  for (const [round, spot] of spots.entries()) {
    const from = round % 2 === 0 ? 1 : 0;
    const to = 1 - from;
    await expect(tabs.nth(from)).toHaveAttribute('aria-selected', 'true');
    await page.locator('.terminal-pane:not(.hidden) .xterm-screen').click();
    await expect(page.locator('.terminal-pane:not(.hidden) textarea')).toBeFocused();
    await page.keyboard.type('echo typing', { delay: 10 });

    const box = await tabs.nth(to).boundingBox();
    if (!box) throw new Error('tab has no box');
    await page.mouse.click(spot(box), box.y + box.height / 2, { delay: 80 });

    await expect(tabs.nth(to)).toHaveAttribute('aria-selected', 'true');
    await expect(tabs.nth(from)).toHaveAttribute('aria-selected', 'false');
    // The keyboard follows: the tab just switched to has the terminal focus.
    await expect(page.locator('.terminal-pane:not(.hidden) textarea')).toBeFocused();
  }
});

test('dragging a tab moves it along the strip without switching to it or touching its shell', async () => {
  launched = await launchApp({ settings: {} });
  const { page } = launched;
  await openDrawer(page);

  const newTab = page.getByRole('button', { name: /^New Terminal/ }).first();
  await newTab.click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(1);
  await newTab.click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(2);
  const tabs = page.getByRole('tablist', { name: 'Terminal sessions' }).getByRole('tab');
  await expect(tabs).toHaveText(['Terminal', 'Terminal 2']);
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  const pids = (await drawerSessions(page)).map((session) => session.pid).sort();

  const first = await tabs.nth(0).boundingBox();
  const second = await tabs.nth(1).boundingBox();
  if (!first || !second) throw new Error('The tabs have no layout');

  // Pick the second tab up by its label and carry it over the first, in steps so the pointer
  // really travels.
  const y = second.y + second.height / 2;
  const fromX = second.x + second.width / 2;
  await page.mouse.move(fromX, y);
  await page.mouse.down();
  await page.mouse.move(fromX - 10, y, { steps: 4 });
  await page.mouse.move(first.x + first.width / 2, y, { steps: 12 });
  // Held: the tab under the pointer follows it, and the one it passes has slid out of the way.
  await expect
    .poll(() => tabs.nth(1).evaluate((tab) => (tab as HTMLElement).style.transform))
    .not.toBe('');
  await expect
    .poll(() => tabs.nth(0).evaluate((tab) => (tab as HTMLElement).style.transform))
    .not.toBe('');
  await page.mouse.up();

  await expect(tabs).toHaveText(['Terminal 2', 'Terminal']);
  // Letting go of a dragged tab must not also switch to it: the one that was active still is.
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'true');
  // Once dropped, both tabs are handed back to their own layout, with no slide left on them.
  await expect
    .poll(() =>
      tabs.evaluateAll((all) => all.map((tab) => (tab as HTMLElement).style.transform).join('|')),
    )
    .toBe('|');
  // Moving a tab is not closing or restarting it: the same two shells are still running.
  expect((await drawerSessions(page)).map((session) => session.pid).sort()).toEqual(pids);

  // A click still switches tabs afterwards.
  await tabs.nth(1).click();
  await expect(tabs.nth(1)).toHaveAttribute('aria-selected', 'true');
  await expect(tabs.nth(0)).toHaveAttribute('aria-selected', 'false');
});

/** What a shell has to run to print these bytes, PowerShell on Windows and printf elsewhere. */
function printCommand(parts: string[]): string {
  if (process.platform === 'win32') {
    // Each part is its own single-quoted string, so the line the shell echoes back never holds
    // the joined text the test looks for.
    const quoted = parts.map((part) =>
      `'${part.replaceAll("'", "''")}'`
        .replaceAll('\x1b', "' + [char]27 + '")
        .replaceAll('\x07', "' + [char]7 + '")
        .replaceAll('\n', "' + [char]10 + '"),
    );
    return `Write-Host -NoNewline (${quoted.join(' + ')})`;
  }
  const escaped = (part: string): string =>
    part.replaceAll('\x1b', '\\033').replaceAll('\x07', '\\007').replaceAll('\n', '\\n');
  return `printf '${parts.map(() => '%b').join('')}' ${parts.map((part) => `'${escaped(part)}'`).join(' ')}`;
}

/** Records every clipboard write from the page, since the real clipboard only takes writes while
 * the window truly has focus, which a test run cannot count on. */
async function recordCopies(page: Page): Promise<void> {
  await page.evaluate(() => {
    const target = window as unknown as { copied?: string[] };
    target.copied = [];
    const original = navigator.clipboard.writeText.bind(navigator.clipboard);
    navigator.clipboard.writeText = async (text: string) => {
      target.copied?.push(text);
      await original(text).catch(() => undefined);
    };
  });
}

function copies(page: Page): Promise<string[]> {
  return page.evaluate(() => (window as unknown as { copied?: string[] }).copied ?? []);
}

test('a link a program prints opens on Ctrl/Cmd+click, and a program can select and copy', async () => {
  launched = await launchApp({ settings: {} });
  const { app, page } = launched;
  await captureOutput(page);
  await openDrawer(page);
  await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(1);
  const [session] = await drawerSessions(page);
  const run = (command: string): Promise<void> =>
    page.evaluate(
      ({ id, text }) => (window as unknown as TerminalApi).runova.terminal.write(id, `${text}\r`),
      { id: session.sessionId, text: command },
    );

  const ready = marker();
  await run(ready.command);
  await expect
    .poll(() => outputFor(page, session.sessionId), { timeout: 90_000 })
    .toContain(ready.expected);

  // Nothing really opens a browser: the main process records what it was asked to open.
  await app.evaluate(({ shell }) => {
    const opened: string[] = [];
    (globalThis as { __e2eOpened?: string[] }).__e2eOpened = opened;
    shell.openExternal = async (url: string) => {
      opened.push(url);
    };
  });
  const opened = (): Promise<string[]> =>
    app.evaluate(async () => (globalThis as { __e2eOpened?: string[] }).__e2eOpened ?? []);
  // xterm's own OSC 8 handler asked first with confirm(), which is how this used to fail.
  const dialogs: string[] = [];
  page.on('dialog', (dialog) => {
    dialogs.push(dialog.message());
    void dialog.dismiss();
  });
  await recordCopies(page);

  const id = randomBytes(4).toString('hex');
  const url = `https://example.com/runova-e2e-${id}`;
  const label = `link-${id}`;
  const copiedByProgram = `copied-${id}`;
  // An OSC 8 hyperlink, the way Claude Code prints its links, then an OSC 52 copy, the way its
  // full-screen mode copies what it has selected.
  await run(
    printCommand([
      `\x1b]8;;${url}\x07`,
      'link',
      `-${id}`,
      '\x1b]8;;\x07',
      // On a row of its own, so the prompt that follows is not drawn in the same span.
      '\n',
      `\x1b]52;c;${Buffer.from(copiedByProgram).toString('base64')}\x07`,
    ]),
  );
  const screen = page.locator('.terminal-pane:not(.hidden) .xterm-rows');
  const link = screen.getByText(label, { exact: true });
  await expect(link).toBeVisible({ timeout: 30_000 });

  await expect.poll(() => copies(page)).toContain(copiedByProgram);

  // The text rows take no pointer events (xterm's screen layer on top of them does), so the
  // mouse goes to where the label is drawn rather than to the element. The label starts its row,
  // and every click lands on its first letter: a click leaves xterm's selection anchor where it
  // was, and Shift+drag on Windows and Linux extends from that anchor.
  const where = async (): Promise<{ left: number; right: number; y: number }> => {
    const box = await link.boundingBox();
    const screenBox = await page.locator('.terminal-pane:not(.hidden) .xterm-screen').boundingBox();
    if (!box || !screenBox) throw new Error('The link has no layout');
    return { left: screenBox.x + 2, right: box.x + box.width - 2, y: box.y + box.height / 2 };
  };
  const pointer = page.locator('.terminal-pane:not(.hidden) .xterm-cursor-pointer');

  // A plain click is for selecting text and opens nothing.
  let spot = await where();
  await page.mouse.move(spot.left, spot.y, { steps: 4 });
  // xterm finds the link under the pointer on hover, and only a link it found can be clicked.
  await expect(pointer).toHaveCount(1);
  await page.mouse.click(spot.left, spot.y);
  await page.waitForTimeout(500);
  expect(await opened()).toEqual([]);

  await page.keyboard.down('ControlOrMeta');
  await page.mouse.click(spot.left, spot.y);
  await page.keyboard.up('ControlOrMeta');
  await expect.poll(opened).toEqual([url]);
  expect(dialogs).toEqual([]);

  // A program that asked for the mouse (Claude Code's full-screen mode does) gets plain drags.
  // Option on a Mac, Shift elsewhere, still selects, and both copy keys then have text to copy.
  await run(printCommand(['\x1b[?1000h']));
  await page.waitForTimeout(500);
  const force = process.platform === 'darwin' ? 'Alt' : 'Shift';
  spot = await where();
  await page.mouse.move(spot.left, spot.y);
  await page.keyboard.down(force);
  await page.mouse.down();
  await page.mouse.move(spot.right, spot.y, { steps: 8 });
  await page.mouse.up();
  await page.keyboard.up(force);

  const before = (await copies(page)).length;
  await page.keyboard.press('ControlOrMeta+C');
  await expect.poll(async () => (await copies(page)).slice(before)).toEqual([label]);

  await page.keyboard.down(force);
  await page.mouse.click(spot.left + 10, spot.y, { button: 'right' });
  await page.keyboard.up(force);
  await expect.poll(async () => (await copies(page)).slice(before)).toEqual([label, label]);
  await run(printCommand(['\x1b[?1000l']));
});

test('quitting with no shells left takes the background host with it', async () => {
  launched = await launchApp({ settings: {} });
  const current = launched;
  const { page, root } = current;
  await openDrawer(page);

  await page.getByRole('button', { name: 'New Terminal', exact: true }).click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toHaveLength(1);
  // The host is a process of its own, started with this profile on its command line.
  expect(processesUnder(root)).toBeGreaterThan(0);

  await page
    .getByRole('button', { name: /^Close / })
    .first()
    .click();
  await expect.poll(() => drawerSessions(page), { timeout: 60_000 }).toEqual([]);

  // A normal quit, not the hard exit close() uses, so the host sees its client leave. The child
  // process is held on to first: once the app is gone Playwright can no longer hand it out, and
  // on macOS the app is often gone before the first look.
  const child = current.app.process();
  const exited = new Promise<void>((resolve) => child.once('exit', () => resolve()));
  await current.app.evaluate(({ app }) => app.quit()).catch(() => undefined);
  await expect.poll(() => child.exitCode ?? child.signalCode, { timeout: 60_000 }).not.toBe(null);
  await exited;

  // An idle host lingers briefly before exiting on its own (IDLE_EXIT_MS in hostEntry.ts).
  await expect.poll(() => processesUnder(root), { timeout: 90_000, intervals: [2_000] }).toBe(0);
});
