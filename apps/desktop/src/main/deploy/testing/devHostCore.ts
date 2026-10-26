import { type ChildProcess, execFileSync, spawn } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { request } from 'node:http';
import { createServer } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * The server core's DevHost for vitest integration tests (E27), the same way e2e/devHost.ts
 * starts it for Playwright: built once with the repo's SDK, run from its DLL on a free loopback
 * port, with a data folder of its own that goes again on stop. (e2e/devHost.ts sits outside the
 * main tsconfig's files, so this is its twin for tests under src.)
 */

const REPO = fileURLToPath(new URL('../../../../../../', import.meta.url));
const PROJECT = join(REPO, 'apps', 'server-core', 'src', 'Runova.ServerCore.DevHost');
const DLL = join(PROJECT, 'bin', 'Debug', 'net10.0', 'Runova.ServerCore.DevHost.dll');
const READY_TIMEOUT_MS = 60_000;

export interface DevHostCore {
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

export async function startDevHostCore(): Promise<DevHostCore> {
  execFileSync('dotnet', ['build', PROJECT, '--nologo', '-v', 'quiet'], { stdio: 'inherit' });
  const port = await freePort();
  const data = mkdtempSync(join(tmpdir(), 'runova-int-devhost-'));
  // Later arguments win, so this replaces the DevHost's own data folder.
  const child: ChildProcess = spawn('dotnet', [DLL, `--Core:DataDirectory=${data}`], {
    env: { ...process.env, RUNOVA_DEV_CORE_PORT: String(port) },
    stdio: 'ignore',
  });
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
    if (await healthy(port)) return { port, stop };
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  stop();
  throw new Error(`The DevHost did not answer on port ${port} within a minute.`);
}
