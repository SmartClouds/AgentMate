import { spawn } from 'node:child_process';
import { constants } from 'node:fs';
import { access } from 'node:fs/promises';
import { posix, win32 } from 'node:path';
import type { DevOs } from '@runova/core';
import { killProcessTree, quoteForCmd, stripAnsi } from '../process/spawnStreaming';
import { withToolPath } from '../toolPaths';
import { pathKey } from '../windowsPath';

/**
 * Short, buffered "is this tool there, and what version" runs for the Dev Setup checklist.
 *
 * The existing `security/exec.probe` is not enough: it returns only stdout and a success flag, but
 * `javac` prints its version on stderr, a missing tool must be told apart from one that failed,
 * and a hung tool needs a tree kill rather than a signal to cmd.exe alone.
 */

export interface ProbeResult {
  /** Exit code 0. */
  ok: boolean;
  code: number | null;
  stdout: string;
  stderr: string;
  /** stdout then stderr, for tools that print their version on either. */
  output: string;
  /** The command could not be found, which is different from it running and failing. */
  notFound: boolean;
  timedOut: boolean;
  /** Why it could not even start, when that was not "not found". */
  error: string | null;
}

export interface ProbeOptions {
  timeoutMs?: number;
  /**
   * Defaults to the app's environment plus the extra tool folders. One that is given is used as it
   * is: the e2e sandbox passes its private PATH, and the extra folders would lead back to the
   * tools this machine really has.
   */
  env?: NodeJS.ProcessEnv;
}

const DEFAULT_TIMEOUT_MS = 10_000;
const MAX_CAPTURE = 64 * 1024;
const NOT_FOUND_TEXT =
  /is not recognized as an internal or external command|command not found|: not found/i;

/** `wsl.exe` writes UTF-16, which arrives here with a NUL between every character. */
export function cleanProbeText(text: string): string {
  return stripAnsi(text.replaceAll('\u0000', ''));
}

function emptyResult(overrides: Partial<ProbeResult>): ProbeResult {
  return {
    ok: false,
    code: null,
    stdout: '',
    stderr: '',
    output: '',
    notFound: false,
    timedOut: false,
    error: null,
    ...overrides,
  };
}

/** A bare name stays bare so `.cmd` shims resolve; anything with a space or symbol is quoted. */
function windowsCommandWord(command: string): string {
  return /^[A-Za-z0-9_.-]+$/.test(command) ? command : quoteForCmd(command);
}

export async function runProbe(
  command: string,
  args: readonly string[],
  options: ProbeOptions = {},
): Promise<ProbeResult> {
  // A blank command reaches spawn as an empty file name, which throws instead of failing the way
  // a missing tool does. Callers run probes without a catch, so it must come back as a result.
  if (!command.trim()) return emptyResult({ notFound: true });

  const env = options.env ? { ...options.env } : await withToolPath();
  const onWindows = process.platform === 'win32';

  let commandLine = '';
  if (onWindows) {
    try {
      // Every part matters: the whole line takes one outer pair of quotes because `cmd /s` strips
      // the first and last quote of what follows /c, and without it a quoted path with a space
      // in it loses its opening quote. Same construction as spawnStreaming.
      commandLine = `"${[windowsCommandWord(command), ...args.map(quoteForCmd)].join(' ')}"`;
    } catch (error) {
      return emptyResult({ error: error instanceof Error ? error.message : String(error) });
    }
  }

  return new Promise<ProbeResult>((resolve) => {
    let stdout = '';
    let stderr = '';
    let settled = false;

    const child = onWindows
      ? spawn('cmd.exe', ['/d', '/s', '/c', commandLine], {
          env,
          windowsHide: true,
          windowsVerbatimArguments: true,
        })
      : spawn(command, [...args], { env, detached: true });

    const finish = (result: Partial<ProbeResult>): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      const cleanOut = cleanProbeText(stdout);
      const cleanErr = cleanProbeText(stderr);
      resolve(
        emptyResult({
          stdout: cleanOut,
          stderr: cleanErr,
          output: [cleanOut, cleanErr].filter((part) => part.trim()).join('\n'),
          ...result,
        }),
      );
    };

    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ timedOut: true });
    }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS);

    child.stdout?.on('data', (chunk: Buffer | string) => {
      if (stdout.length < MAX_CAPTURE) stdout += chunk.toString();
    });
    child.stderr?.on('data', (chunk: Buffer | string) => {
      if (stderr.length < MAX_CAPTURE) stderr += chunk.toString();
    });
    child.on('error', (error: NodeJS.ErrnoException) => {
      if (error.code === 'ENOENT') finish({ notFound: true });
      else finish({ error: error.message });
    });
    child.on('close', (code) => {
      const missing =
        code !== 0 &&
        (code === 127 || code === 9009 || NOT_FOUND_TEXT.test(`${stdout}\n${stderr}`));
      finish({ ok: code === 0, code, notFound: missing });
    });
  });
}

export interface FindExecutableOptions {
  env: Readonly<Record<string, string | undefined>>;
  os: DevOs;
  exists: (path: string) => Promise<boolean>;
}

/** Where on PATH a command lives, looked up the way a shell would, without starting it. */
export async function findExecutable(
  command: string,
  options: FindExecutableOptions,
): Promise<string | null> {
  const { env, os, exists } = options;
  const path = os === 'win32' ? win32 : posix;
  const separator = os === 'win32' ? ';' : ':';
  const dirs = (env[pathKey(env as NodeJS.ProcessEnv)] ?? '').split(separator).filter(Boolean);
  const extensionsKey = Object.keys(env).find((key) => key.toUpperCase() === 'PATHEXT');
  const extensions =
    os === 'win32'
      ? (env[extensionsKey ?? 'PATHEXT'] ?? '.COM;.EXE;.BAT;.CMD').split(';').filter(Boolean)
      : [''];
  for (const dir of dirs) {
    for (const extension of extensions) {
      const candidate = path.join(dir, `${command}${extension}`);
      if (await exists(candidate)) return candidate;
    }
  }
  return null;
}

/** True when the path exists and, off Windows, can be executed. */
export async function isExecutableFile(file: string): Promise<boolean> {
  try {
    await access(file, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
    return true;
  } catch {
    return false;
  }
}
