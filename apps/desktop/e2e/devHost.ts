import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { APP_ROOT, E2E_OUT_DIR } from './paths';

/**
 * The server core's DevHost for e2e runs: the real core on loopback TCP, so the Deploy page can
 * be driven end to end on machines without Linux or systemd. Built once per run with the SDK the
 * repo pins, then started straight from its DLL, with a data folder of its own that is deleted
 * again on stop: what a run changes (two-factor on, say) never reaches the next run, or the
 * DevHost a developer uses by hand.
 */

const PROJECT = join(APP_ROOT, '..', 'server-core', 'src', 'Runova.ServerCore.DevHost');
const DLL = join(PROJECT, 'bin', 'Debug', 'net10.0', 'Runova.ServerCore.DevHost.dll');
const READY_TIMEOUT_MS = 60_000;
const BUILD_LOCK = join(E2E_OUT_DIR, 'devhost-build.lock');
const BUILD_MARKER = join(E2E_OUT_DIR, 'devhost-built');
const BUILD_LOCK_STALE_MS = 10 * 60_000;

export interface DevHost {
  port: number;
  stop: () => void;
}

export function dotnetAvailable(): boolean {
  try {
    execFileSync('dotnet', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const address = probe.address();
      probe.close(() =>
        typeof address === 'object' && address
          ? resolve(address.port)
          : reject(new Error('no port')),
      );
    });
  });
}

/** The same request the app makes: health, with the Host header the core allows. */
function healthy(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const call = request(
      { host: '127.0.0.1', port, path: '/api/v1/health', headers: { host: 'runova-core' } },
      (response) => {
        response.resume();
        resolve(response.statusCode === 200);
      },
    );
    call.once('error', () => resolve(false));
    call.setTimeout(2_000, () => call.destroy());
    call.end();
  });
}

/**
 * Builds the DevHost the first time a run asks for it. Workers run side by side, and two
 * `dotnet build`s of one project at once fight over its obj and bin folders, so the build is
 * taken under a lock folder and a marker records the run (see globalSetup) that built it.
 */
async function buildOncePerRun(): Promise<void> {
  const runId = process.env.RUNOVA_E2E_RUN_ID ?? '';
  const isBuilt = () => runId !== '' && readMarker() === runId;
  if (isBuilt()) return;
  mkdirSync(E2E_OUT_DIR, { recursive: true });
  for (;;) {
    try {
      mkdirSync(BUILD_LOCK);
      break;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
      // A worker killed mid-build leaves its lock behind; no build takes this long.
      if (Date.now() - lockTakenAt() > BUILD_LOCK_STALE_MS)
        rmSync(BUILD_LOCK, { recursive: true, force: true });
      await new Promise((resolve) => setTimeout(resolve, 500));
    }
  }
  try {
    if (isBuilt()) return;
    execFileSync('dotnet', ['build', PROJECT, '--nologo', '-v', 'quiet'], { stdio: 'inherit' });
    writeFileSync(BUILD_MARKER, runId);
  } finally {
    rmSync(BUILD_LOCK, { recursive: true, force: true });
  }
}

function readMarker(): string | null {
  try {
    return readFileSync(BUILD_MARKER, 'utf-8');
  } catch {
    return null;
  }
}

/** When the lock was taken, or now if it is already gone. */
function lockTakenAt(): number {
  try {
    return statSync(BUILD_LOCK).mtimeMs;
  } catch {
    return Date.now();
  }
}

/** `args` go on the DevHost's command line after its own, such as a setting a spec needs. */
export async function startDevHost(options: { args?: string[] } = {}): Promise<DevHost> {
  await buildOncePerRun();
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'runova-e2e-devhost-'));
  // Later arguments win, so this replaces the DevHost's own data folder.
  const child: ChildProcess = spawn(
    'dotnet',
    [DLL, `--Core:DataDirectory=${data}`, ...(options.args ?? [])],
    {
      env: { ...process.env, RUNOVA_DEV_CORE_PORT: String(port) },
      stdio: 'ignore',
    },
  );
  const stop = () => {
    if (child.exitCode === null) child.kill();
    try {
      // Windows can hold the database a moment after the process ends.
      rmSync(data, { recursive: true, force: true, maxRetries: 10, retryDelay: 200 });
    } catch {
      // A temp folder left behind is harmless.
    }
  };
  const deadline = Date.now() + READY_TIMEOUT_MS;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`The DevHost exited with code ${child.exitCode}.`);
    if (await healthy(port)) {
      if (existsSync(join(data, 'core.db'))) return { port, stop };
      stop();
      throw new Error(`The DevHost did not keep its data in ${data}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw new Error(`The DevHost did not answer on port ${port} within a minute.`);
}
