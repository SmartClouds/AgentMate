import { expect, type Page, test } from '@playwright/test';
import { type LaunchedApp, launchApp } from './app';
import { type FakeOllama, startFakeOllama } from './fakeOllama';
import {
  buildRdpServerImage,
  dockerAvailable,
  RDP_PASSWORD,
  RDP_USER,
  type RdpTestServer,
  rdpExec,
  startRdpServer,
} from './rdpServer';

/**
 * "Ask AI" on a real Remote Desktop session: xrdp with XFCE in Docker, the app's own RDP client,
 * and a fake Ollama following a script. Every action really goes through the session window, so
 * the checks are made on the server itself.
 */

test.skip(!dockerAvailable(), 'needs Docker to start the test RDP server');

interface HistoryEntry {
  kind: string;
  action?: string;
  outcome?: string;
  ok?: boolean;
  text?: string;
}

interface HistoryRun {
  status: string;
  entries: HistoryEntry[];
}

interface Bridge {
  rdp: {
    saveServer(input: unknown): Promise<{ id: string }>;
    openSession(serverId: string): Promise<string>;
  };
  rdpAgent: {
    start(input: unknown): Promise<void>;
    history(sessionId: string): Promise<HistoryRun[]>;
  };
}

const WIDTH = 1280;
const HEIGHT = 800;
/** xrdp opens on its own login dialog with the password field focused; the AI signs in first. */
const SIGN_IN = [`TYPE "${RDP_PASSWORD}\\n"`, 'WAIT 8000'];

let server: RdpTestServer | undefined;
let ollama: FakeOllama | undefined;
let launched: LaunchedApp | undefined;

test.beforeAll(() => {
  test.setTimeout(1_500_000);
  buildRdpServerImage();
});

// A fresh server per test: xrdp keeps the desktop alive across disconnects, so a second test on
// the same container would find the first one's windows and files.
test.beforeEach(async () => {
  test.setTimeout(300_000);
  server = await startRdpServer();
});

test.afterEach(async () => {
  const testInfo = test.info();
  // What the AI saw last says more about a failure than a screenshot of the toolbar.
  const lastFrame = ollama?.images.filter((images) => images.length > 0).at(-1)?.[0];
  if (testInfo.status !== testInfo.expectedStatus && lastFrame) {
    await testInfo.attach('last-frame.png', {
      body: Buffer.from(lastFrame, 'base64'),
      contentType: 'image/png',
    });
  }
  await launched?.close();
  launched = undefined;
  await ollama?.close();
  ollama = undefined;
  server?.stop();
  server = undefined;
});

/** Opens a session on the test server and returns its window once the desktop is connected. */
async function openSession(replies: string[]): Promise<{ page: Page; sessionId: string }> {
  if (!server) throw new Error('RDP server did not start');
  ollama = await startFakeOllama(replies);
  launched = await launchApp({
    settings: {
      promptBuilderProvider: 'ollama',
      ollamaModel: 'e2e-script',
      ollamaBaseUrl: ollama.url,
    },
  });
  const { app, page } = launched;

  // Saved through the app itself, so the password is encrypted the way a real save does it.
  const saved = await page.evaluate(
    (input) => (window as unknown as { runova: Bridge }).runova.rdp.saveServer(input),
    {
      nickname: 'E2E desktop',
      host: server.host,
      port: server.port,
      username: RDP_USER,
      secret: RDP_PASSWORD,
      options: {
        resolution: { width: WIDTH, height: HEIGHT },
        fullscreenOnConnect: false,
        maximizeOnConnect: true,
        clipboard: false,
        fileTransfer: false,
        nla: false,
      },
    },
  );
  const sessionWindow = app.waitForEvent('window', {
    predicate: (win) => win.url().includes('rdp-session'),
    timeout: 30_000,
  });
  const sessionId = await page.evaluate(
    (id) => (window as unknown as { runova: Bridge }).runova.rdp.openSession(id),
    saved.id,
  );
  const session = await sessionWindow;
  await session.waitForFunction(() => Boolean((window as { runova?: unknown }).runova));
  // The button only turns on once the session is connected.
  await expect(session.getByRole('button', { name: /Ask AI/ })).toBeEnabled({ timeout: 60_000 });
  // Connected comes before the first picture; the AI should not start on a blank screen.
  await session.waitForTimeout(5000);
  return { page: session, sessionId };
}

/** Starts the task fully autonomous on the Settings provider and waits for the run to end. */
async function runTask(page: Page, sessionId: string, prompt: string): Promise<HistoryRun> {
  await page.evaluate(
    (input) => (window as unknown as { runova: Bridge }).runova.rdpAgent.start(input),
    { sessionId, prompt, mode: 'autonomous', cliId: null },
  );
  let run: HistoryRun | undefined;
  await expect
    .poll(
      async () => {
        const runs = await page.evaluate(
          (id) => (window as unknown as { runova: Bridge }).runova.rdpAgent.history(id),
          sessionId,
        );
        run = runs[0];
        return run?.status ?? 'none';
      },
      { timeout: 180_000, intervals: [1000] },
    )
    .not.toMatch(/^(running|none)$/);
  if (!run) throw new Error('no run in the history');
  // A pause or error is reported with everything that happened, so a failure needs no rerun.
  expect(run.status, JSON.stringify(run.entries, null, 2)).toBe('finished');
  return run;
}

function actions(run: HistoryRun): HistoryEntry[] {
  return run.entries.filter((entry) => entry.kind === 'action');
}

/** Width and height from a PNG's IHDR chunk, or null when the bytes are not a PNG. */
function pngSize(base64: string): { width: number; height: number } | null {
  const bytes = Buffer.from(base64, 'base64');
  const signature = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  if (bytes.length < 24 || !bytes.subarray(0, 8).equals(signature)) return null;
  if (bytes.subarray(12, 16).toString('ascii') !== 'IHDR') return null;
  return { width: bytes.readUInt32BE(16), height: bytes.readUInt32BE(20) };
}

test('signs in, types a command into a terminal and drags its window', async () => {
  const { page, sessionId } = await openSession([
    ...SIGN_IN,
    // The terminal starts from the session's autostart, at the top left; a click gives it focus.
    'CLICK 400 300',
    'TYPE "echo rdp-ok > /tmp/rdp-e2e.txt\\n"',
    'WAIT 1500',
    'DRAG 300 45 500 145',
    'FINISHED: Wrote the file.',
  ]);
  const run = await runTask(page, sessionId, 'Write rdp-ok to /tmp/rdp-e2e.txt in a terminal');

  if (!server) throw new Error('RDP server did not start');
  expect(rdpExec(server, 'cat /tmp/rdp-e2e.txt')).toBe('rdp-ok');

  const done = actions(run);
  expect(done.map((entry) => entry.action)).toEqual([
    `TYPE "${RDP_PASSWORD}\\n"`,
    'WAIT 8000',
    'CLICK 400 300',
    'TYPE "echo rdp-ok > /tmp/rdp-e2e.txt\\n"',
    'WAIT 1500',
    'DRAG 300 45 500 145',
  ]);
  for (const entry of done) expect(entry.ok, JSON.stringify(entry)).toBe(true);
  expect(run.entries.at(-1)).toMatchObject({ kind: 'finished', text: 'Wrote the file.' });

  // The terminal opens with its client area at 10,88, so the drag by 200,100 puts it here. The
  // start depends on xfwm's frame and the image's default font: if a new ubuntu:24.04 moves it,
  // update both numbers rather than suspecting the drag.
  expect(rdpExec(server, "xdotool search --name '^Terminal - ' getwindowgeometry %@")).toContain(
    'Position: 210,188 ',
  );
});

test('moves the pointer to the exact remote pixel', async () => {
  const { page, sessionId } = await openSession([...SIGN_IN, 'MOVE 200 150', 'FINISHED: Moved.']);
  const run = await runTask(page, sessionId, 'Point at 200, 150');
  for (const entry of actions(run)) expect(entry.ok, JSON.stringify(entry)).toBe(true);

  if (!server) throw new Error('RDP server did not start');
  // The X server inside the session is the judge of where the pointer is, not the client.
  expect(rdpExec(server, 'xdotool getmouselocation')).toMatch(/^x:200 y:150 /);
});

test('sends a full-size PNG of the desktop with every request', async () => {
  const { page, sessionId } = await openSession([...SIGN_IN, 'FINISHED: Looked.']);
  await runTask(page, sessionId, 'Sign in and look around');

  expect(ollama?.images.length).toBe(SIGN_IN.length + 1);
  for (const images of ollama?.images ?? []) {
    expect(images).toHaveLength(1);
    expect(pngSize(images[0] ?? '')).toEqual({ width: WIDTH, height: HEIGHT });
  }
});
