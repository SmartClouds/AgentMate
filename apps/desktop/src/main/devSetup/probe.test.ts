import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';

// The real withToolPath would start Python to look for script folders. These tests care about the
// probe, so the environment passes through untouched.
vi.mock('../toolPaths', () => ({
  withToolPath: vi.fn(async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) })),
}));

import { withToolPath } from '../toolPaths';
import { cleanProbeText, findExecutable, runProbe } from './probe';

/**
 * Probes run real child processes, so fake tools are put on a temp PATH rather than mocking the
 * process layer. That is what proves the Windows quoting and the not-found detection, which a mock
 * could only agree with.
 */

const onWindows = process.platform === 'win32';
let binDir = '';

function envWithPath(...dirs: string[]): NodeJS.ProcessEnv {
  const system = onWindows
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];
  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  return { ...process.env, [key]: [...dirs, ...system].join(delimiter) };
}

/** A fake tool: `lines` are shell lines for POSIX and cmd lines for Windows. */
function writeTool(dir: string, name: string, windows: string[], posix: string[]): string {
  mkdirSync(dir, { recursive: true });
  if (onWindows) {
    const file = join(dir, `${name}.cmd`);
    writeFileSync(file, ['@echo off', ...windows, ''].join('\r\n'));
    return file;
  }
  const file = join(dir, name);
  writeFileSync(file, ['#!/bin/sh', ...posix, ''].join('\n'));
  chmodSync(file, 0o755);
  return file;
}

beforeEach(() => {
  binDir = join(tempDir('runova-probe-'), 'bin');
  mkdirSync(binDir, { recursive: true });
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('runProbe', () => {
  it('uses a given environment as it is, without the extra tool folders', async () => {
    // The e2e sandbox hands over a private PATH. The extra folders are this machine's real ones
    // (~/.local/bin, Homebrew), where a tool the test means to be missing may well be installed.
    writeTool(binDir, 'faketool', ['echo faketool 1.2.3'], ['echo "faketool 1.2.3"']);
    vi.mocked(withToolPath).mockClear();

    const result = await runProbe('faketool', ['--version'], { env: envWithPath(binDir) });

    expect(result.ok).toBe(true);
    expect(withToolPath).not.toHaveBeenCalled();
  });

  it('returns what a tool prints and that it succeeded', async () => {
    writeTool(binDir, 'faketool', ['echo faketool 1.2.3'], ['echo "faketool 1.2.3"']);

    const result = await runProbe('faketool', ['--version'], { env: envWithPath(binDir) });

    expect(result.ok).toBe(true);
    expect(result.code).toBe(0);
    expect(result.stdout).toContain('faketool 1.2.3');
    expect(result.notFound).toBe(false);
    expect(result.timedOut).toBe(false);
  });

  it('keeps stderr apart, but includes it in the combined output (javac prints its version there)', async () => {
    writeTool(binDir, 'fakejavac', ['echo javac 17.0.12 1>&2'], ['echo "javac 17.0.12" 1>&2']);

    const result = await runProbe('fakejavac', ['-version'], { env: envWithPath(binDir) });

    expect(result.stdout.trim()).toBe('');
    expect(result.stderr).toContain('javac 17.0.12');
    expect(result.output).toContain('javac 17.0.12');
  });

  it('reports a failing tool as not ok, without calling it missing', async () => {
    writeTool(binDir, 'failing', ['echo nope', 'exit /b 3'], ['echo nope', 'exit 3']);

    const result = await runProbe('failing', [], { env: envWithPath(binDir) });

    expect(result.ok).toBe(false);
    expect(result.code).toBe(3);
    expect(result.notFound).toBe(false);
  });

  it('says so when the tool does not exist at all', async () => {
    const result = await runProbe('definitely-not-installed-xyz', ['--version'], {
      env: envWithPath(binDir),
    });

    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
    expect(result.timedOut).toBe(false);
  });

  it('gives up on a tool that hangs, and says it timed out', async () => {
    writeTool(binDir, 'hangs', ['ping -n 20 127.0.0.1 >nul'], ['sleep 20']);
    const started = Date.now();

    const result = await runProbe('hangs', [], { env: envWithPath(binDir), timeoutMs: 400 });

    expect(result.timedOut).toBe(true);
    expect(result.ok).toBe(false);
    expect(Date.now() - started).toBeLessThan(8000);
  });

  it('passes arguments through, including one with a space', async () => {
    writeTool(binDir, 'echoargs', ['echo ARGS: %*'], ['echo "ARGS: $@"']);

    const result = await runProbe('echoargs', ['--format', 'a b'], { env: envWithPath(binDir) });

    expect(result.stdout).toContain('--format');
    expect(result.stdout).toContain('a b');
  });

  it('runs a tool by absolute path even when the folder name has a space in it', async () => {
    const spaced = join(tempDir('runova-probe-'), 'Program Files', 'Tool');
    const file = writeTool(spaced, 'spaced', ['echo spaced 4.5.6'], ['echo "spaced 4.5.6"']);

    const result = await runProbe(file, ['--version'], { env: envWithPath() });

    expect(result.ok).toBe(true);
    expect(result.stdout).toContain('spaced 4.5.6');
  });

  it('does not throw for an empty command', async () => {
    const result = await runProbe('  ', []);

    expect(result.ok).toBe(false);
    expect(result.notFound).toBe(true);
  });
});

describe('cleanProbeText', () => {
  it('removes the NUL bytes of UTF-16 output, which is how wsl.exe prints', () => {
    expect(cleanProbeText('W\0S\0L\0 \0v\0e\0r\0s\0i\0o\0n\0')).toBe('WSL version');
  });

  it('removes color codes and carriage returns', () => {
    expect(cleanProbeText('\u001B[32mok\u001B[0m\r\n')).toBe('ok\n');
  });
});

describe('findExecutable', () => {
  const exists = (present: string[]) => async (path: string) => present.includes(path);

  it('finds a command in the first PATH folder that has it', async () => {
    const found = await findExecutable('git', {
      env: { PATH: '/a:/b' },
      os: 'linux',
      exists: exists(['/b/git', '/a/git']),
    });

    expect(found).toBe('/a/git');
  });

  it('tries each extension from PATHEXT on Windows', async () => {
    const found = await findExecutable('npm', {
      env: { Path: 'C:\\nodejs;C:\\other', PATHEXT: '.COM;.EXE;.CMD' },
      os: 'win32',
      exists: exists(['C:\\nodejs\\npm.CMD']),
    });

    expect(found).toBe('C:\\nodejs\\npm.CMD');
  });

  it('is null when nothing on PATH has it', async () => {
    expect(
      await findExecutable('git', { env: { PATH: '/a' }, os: 'linux', exists: exists([]) }),
    ).toBeNull();
  });

  it('is null when PATH is empty or missing', async () => {
    expect(await findExecutable('git', { env: {}, os: 'linux', exists: exists([]) })).toBeNull();
  });
});
