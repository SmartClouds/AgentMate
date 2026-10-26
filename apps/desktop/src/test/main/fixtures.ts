import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach } from 'vitest';

/** Small building blocks for main-process tests: temp trees, git repos, local servers. */

const created: string[] = [];

afterEach(() => {
  while (created.length > 0) {
    const dir = created.pop();
    if (!dir) continue;
    try {
      rmSync(dir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
    } catch {
      // On Windows a git process that has not fully exited still holds the folder, and the
      // removal fails with EBUSY. It lives in the temp directory, so leaving it there is fine,
      // and failing the test that just passed over it would be worse.
    }
  }
});

/** A folder removed after the test, whatever it ends up containing. */
export function tempDir(prefix = 'runova-test-'): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  created.push(dir);
  return dir;
}

/** Writes a whole tree at once: keys are relative paths, values file contents. */
export function writeTree(root: string, files: Record<string, string>): string {
  for (const [relative, contents] of Object.entries(files)) {
    const target = join(root, relative);
    mkdirSync(dirname(target), { recursive: true });
    writeFileSync(target, contents, 'utf-8');
  }
  return root;
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf-8',
    env: {
      ...process.env,
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: join(cwd, '.gitconfig-test'),
      GIT_AUTHOR_NAME: 'Runova Test',
      GIT_AUTHOR_EMAIL: 'test@runova.invalid',
      GIT_COMMITTER_NAME: 'Runova Test',
      GIT_COMMITTER_EMAIL: 'test@runova.invalid',
    },
  });
}

/** True when a `git` binary is on PATH, so a suite can skip instead of failing. */
export function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

/**
 * A repository with one commit on `main`, for tests that read real git output rather than a
 * mocked child process. Returns helpers bound to that folder.
 */
export function initGitRepo(files: Record<string, string> = { 'README.md': '# test\n' }): {
  dir: string;
  git: (...args: string[]) => string;
  commitAll: (message: string) => void;
} {
  const dir = tempDir('runova-repo-');
  git(dir, 'init', '--initial-branch=main');
  git(dir, 'config', 'user.name', 'Runova Test');
  git(dir, 'config', 'user.email', 'test@runova.invalid');
  git(dir, 'config', 'commit.gpgsign', 'false');
  writeTree(dir, files);
  git(dir, 'add', '.');
  git(dir, 'commit', '-m', 'first commit');
  return {
    dir,
    git: (...args: string[]) => git(dir, ...args),
    commitAll: (message: string) => {
      git(dir, 'add', '.');
      git(dir, 'commit', '-m', message);
    },
  };
}

export interface LocalServer {
  url: string;
  port: number;
  requests: {
    method: string;
    url: string;
    headers: NodeJS.Dict<string | string[]>;
    body: string;
  }[];
  close: () => Promise<void>;
}

/**
 * An HTTP server on a free port, for code that calls `fetch`. The request log includes bodies,
 * so a test can assert on what was sent.
 */
export async function startHttpServer(
  handler: (
    request: IncomingMessage,
    response: ServerResponse,
    body: string,
  ) => void | Promise<void>,
): Promise<LocalServer> {
  const requests: LocalServer['requests'] = [];
  const server: Server = createServer((request, response) => {
    const chunks: Buffer[] = [];
    request.on('data', (chunk: Buffer) => chunks.push(chunk));
    request.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf-8');
      requests.push({
        method: request.method ?? 'GET',
        url: request.url ?? '/',
        headers: request.headers,
        body,
      });
      void handler(request, response, body);
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address ? address.port : 0;

  return {
    url: `http://127.0.0.1:${port}`,
    port,
    requests,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections?.();
        server.close(() => resolve());
      }),
  };
}

/** Sends one JSON reply. Shorthand for the common `startHttpServer` handler. */
export function json(response: ServerResponse, body: unknown, status = 200): void {
  response.writeHead(status, { 'content-type': 'application/json' });
  response.end(JSON.stringify(body));
}

/**
 * Runs `work` with `process.platform` reporting another OS, then puts it back. Lets one test
 * cover the Windows and POSIX branches of path and shell code on either machine.
 */
export async function withPlatform<Result>(
  platform: NodeJS.Platform,
  work: () => Result | Promise<Result>,
): Promise<Result> {
  const original = process.platform;
  Object.defineProperty(process, 'platform', { value: platform, configurable: true });
  try {
    return await work();
  } finally {
    Object.defineProperty(process, 'platform', { value: original, configurable: true });
  }
}
