import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { readdir, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { promisify } from 'node:util';
import { type GrammarSettings, LANGUAGETOOL_SERVER_JAR } from '@runova/core';
import { app } from 'electron';
import type { GrammarLocalStatus, GrammarServerState } from '../../shared/grammar';
import { IPC } from '../../shared/ipcChannels';
import { broadcastToWindows } from '../ipc/send';

const execFileAsync = promisify(execFile);

/**
 * Where the user drops tools Runova runs but doesn't install: today only the
 * LanguageTool distribution. Under userData so it survives app updates and is
 * never inside the read-only asar.
 */
export function toolsDir(): string {
  return join(app.getPath('userData'), 'tools');
}

/** Dictionaries and rules take a while to load, and a cold JVM start is slower still. */
const READY_TIMEOUT_MS = 120_000;
const READY_POLL_MS = 600;
const PROBE_TIMEOUT_MS = 1500;
const JAVA_PROBE_TIMEOUT_MS = 5000;

interface LocalInstall {
  /** Folder holding languagetool-server.jar. */
  path: string;
  jarPath: string;
  version: string | null;
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

/** "LanguageTool-6.6" -> "6.6"; anything else has no version to read. */
function versionFromFolderName(name: string): string | null {
  const match = /^languagetool[-_ ]?v?(\d[\w.]*)$/i.exec(name);
  return match ? match[1] : null;
}

async function installAt(dir: string, folderName: string): Promise<LocalInstall | null> {
  const jarPath = join(dir, LANGUAGETOOL_SERVER_JAR);
  if (!(await isFile(jarPath))) return null;
  return { path: dir, jarPath, version: versionFromFolderName(folderName) };
}

/**
 * Finds the LanguageTool distribution under the tools folder. Extracting the zip
 * usually leaves a `LanguageTool-6.6` folder, but people also rename it to
 * `languagetool` or extract it so the jar lands directly in `tools`, and some
 * unzip tools nest it one level deeper, so all four shapes are accepted.
 */
export async function findLocalInstall(): Promise<LocalInstall | null> {
  const root = toolsDir();
  const direct = await installAt(root, 'tools');
  if (direct) return direct;

  let entries: string[];
  try {
    entries = (await readdir(root, { withFileTypes: true }))
      .filter((entry) => entry.isDirectory())
      .map((entry) => entry.name);
  } catch {
    return null;
  }

  // A "LanguageTool-…" folder first, so a stray unrelated folder that happens to
  // hold a jar of the same name can't win over the real distribution.
  const ranked = entries.sort((a, b) => {
    const score = (name: string): number => (/^languagetool/i.test(name) ? 0 : 1);
    return score(a) - score(b) || b.localeCompare(a);
  });

  for (const name of ranked) {
    const dir = join(root, name);
    const found = await installAt(dir, name);
    if (found) return found;

    let nested: string[];
    try {
      nested = (await readdir(dir, { withFileTypes: true }))
        .filter((entry) => entry.isDirectory() && /^languagetool/i.test(entry.name))
        .map((entry) => entry.name);
    } catch {
      continue;
    }
    for (const nestedName of nested) {
      const deeper = await installAt(join(dir, nestedName), nestedName);
      if (deeper) return deeper;
    }
  }
  return null;
}

/** LanguageTool 6 is built for this; an older JVM refuses to load its classes. */
const MIN_JAVA_MAJOR = 17;

/**
 * Reads the major version out of a `java -version` line, both the old
 * `1.8.0_361` shape and the modern `11.0.32` / `21` one.
 */
function javaMajorFrom(versionLine: string): number | null {
  const match = /version\s+"?(\d+)(?:\.(\d+))?/.exec(versionLine);
  if (!match) return null;
  const first = Number(match[1]);
  if (first === 1) return match[2] ? Number(match[2]) : null;
  return Number.isFinite(first) ? first : null;
}

/** First line of `java -version`, which Java prints on stderr. Null means it isn't on PATH. */
async function detectJava(): Promise<string | null> {
  try {
    const { stdout, stderr } = await execFileAsync('java', ['-version'], {
      timeout: JAVA_PROBE_TIMEOUT_MS,
      windowsHide: true,
    });
    const output = `${stderr}${stdout}`.trim();
    return output.split('\n')[0]?.trim() || null;
  } catch {
    return null;
  }
}

export function localBaseUrl(port: number): string {
  return `http://127.0.0.1:${port}`;
}

/** Whether something on this port answers LanguageTool's own languages endpoint. */
async function probe(port: number): Promise<boolean> {
  try {
    const response = await fetch(`${localBaseUrl(port)}/v2/languages`, {
      signal: AbortSignal.timeout(PROBE_TIMEOUT_MS),
    });
    if (!response.ok) return false;
    const body: unknown = await response.json();
    return Array.isArray(body);
  } catch {
    return false;
  }
}

let child: ChildProcess | null = null;
let starting: Promise<void> | null = null;
let lastError: string | null = null;
let javaVersionCache: string | null = null;
let javaProbed = false;

function broadcast(status: GrammarLocalStatus): void {
  broadcastToWindows(IPC.grammar.onLocalStatus, status);
}

async function currentState(port: number): Promise<GrammarServerState> {
  if (await probe(port)) return 'running';
  if (starting) return 'starting';
  if (lastError) return 'error';
  return 'stopped';
}

export async function getLocalStatus(settings: GrammarSettings): Promise<GrammarLocalStatus> {
  const [install, state] = await Promise.all([
    findLocalInstall(),
    currentState(settings.localPort),
  ]);
  // `java -version` spawns a JVM, which is slow, so it's read once per app run.
  // Installing Java afterwards is rare enough to be worth a restart.
  if (!javaProbed) {
    javaVersionCache = await detectJava();
    javaProbed = true;
  }
  return {
    toolsDir: toolsDir(),
    installPath: install?.path ?? null,
    version: install?.version ?? null,
    javaVersion: javaVersionCache,
    javaMajor: javaVersionCache ? javaMajorFrom(javaVersionCache) : null,
    serverState: state,
    port: settings.localPort,
    error: lastError,
  };
}

async function pushStatus(settings: GrammarSettings): Promise<void> {
  broadcast(await getLocalStatus(settings));
}

async function waitUntilReady(port: number): Promise<void> {
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (await probe(port)) return;
    // A JVM that died on startup (bad jar, port taken) never answers, so give up
    // as soon as the process is gone instead of waiting out the whole timeout.
    if (child && child.exitCode !== null) {
      throw new Error(lastError ?? `LanguageTool exited with code ${child.exitCode}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, READY_POLL_MS));
  }
  throw new Error('LanguageTool did not answer in time. Check the tools folder and Java install.');
}

/**
 * Starts the local server if it isn't up already. Concurrent callers (the
 * Settings button and the first check that needs it) share one attempt.
 */
export async function startLocalServer(settings: GrammarSettings): Promise<GrammarLocalStatus> {
  if (starting) {
    await starting.catch(() => undefined);
    return getLocalStatus(settings);
  }
  // Someone else's server on that port (a Docker container, a manual java run)
  // is a perfectly good backend, so leave it alone and use it.
  if (await probe(settings.localPort)) {
    lastError = null;
    return getLocalStatus(settings);
  }

  const install = await findLocalInstall();
  if (!install) {
    lastError = `No LanguageTool found in ${toolsDir()}. Extract LanguageTool-stable.zip there.`;
    return getLocalStatus(settings);
  }
  const java = javaProbed ? javaVersionCache : await detectJava();
  javaVersionCache = java;
  javaProbed = true;
  if (!java) {
    lastError = 'Java was not found on PATH. LanguageTool needs Java 17 or newer to run.';
    return getLocalStatus(settings);
  }

  lastError = null;
  const port = settings.localPort;
  starting = (async () => {
    const proc = spawn(
      'java',
      [
        // Enough for the English rules plus one more language; the server grows
        // its heap lazily, so this is a ceiling rather than an allocation.
        '-Xmx1g',
        '-cp',
        install.jarPath,
        'org.languagetool.server.HTTPServer',
        '--port',
        String(port),
      ],
      { cwd: install.path, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    child = proc;

    // The JVM reports a taken port or a missing class on stderr and then exits;
    // keeping the last line makes the Settings card able to say why.
    proc.stderr?.on('data', (chunk: Buffer) => {
      const line = chunk.toString().trim().split('\n').pop()?.trim();
      if (line) lastError = line.slice(0, 300);
    });
    proc.on('exit', (code, signal) => {
      if (child === proc) child = null;
      // A clean stop we asked for isn't an error worth showing.
      if (signal === 'SIGTERM' || code === 0) lastError = null;
      void pushStatus(settings);
    });
    proc.on('error', (error) => {
      lastError = error.message;
    });

    try {
      await waitUntilReady(port);
      lastError = null;
    } catch (error) {
      const reason = error instanceof Error ? error.message : String(error);
      // An old JVM fails with a class-version error that says nothing useful to
      // anyone who hasn't seen it before, so name the actual requirement.
      const major = javaVersionCache ? javaMajorFrom(javaVersionCache) : null;
      lastError =
        major !== null && major < MIN_JAVA_MAJOR
          ? `LanguageTool needs Java ${MIN_JAVA_MAJOR} or newer, and this machine has Java ${major}. Install a newer JDK, or use the online check. (${reason})`
          : reason;
      proc.kill();
      throw error;
    }
  })();

  void pushStatus(settings);
  try {
    await starting;
  } catch {
    // Reported through `lastError` in the status below.
  } finally {
    starting = null;
  }
  const status = await getLocalStatus(settings);
  broadcast(status);
  return status;
}

export async function stopLocalServer(settings: GrammarSettings): Promise<GrammarLocalStatus> {
  const proc = child;
  child = null;
  starting = null;
  if (proc) {
    proc.kill();
    // Windows ignores SIGTERM for a JVM often enough that a hard kill is the
    // fallback, after a grace period for the graceful shutdown to land.
    setTimeout(() => {
      if (proc.exitCode === null) proc.kill('SIGKILL');
    }, 3000).unref();
  }
  lastError = null;
  const status = await getLocalStatus(settings);
  broadcast(status);
  return status;
}

/** Called on quit so a spawned JVM never outlives the app. */
export function shutdownLocalServer(): void {
  child?.kill();
  child = null;
}

/**
 * Base URL to send a check to, starting the server first if that's what it
 * takes. Throws with a readable reason when local mode can't be satisfied, so
 * the field showing the check can say what to fix.
 */
export async function ensureLocalServer(settings: GrammarSettings): Promise<string> {
  const status = await startLocalServer(settings);
  if (status.serverState !== 'running') {
    throw new Error(status.error ?? 'The local LanguageTool server is not running.');
  }
  return localBaseUrl(settings.localPort);
}
