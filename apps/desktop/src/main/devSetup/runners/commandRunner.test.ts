import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../../test/main/fixtures';
import type { CancelToken } from '../../process/spawnStreaming';
import { runCommand } from './commandRunner';

/**
 * Starting Flutter for its first run. It lives under the person's home folder, and that folder can
 * have a space in its name ("C:\Users\John Smith"), which is what broke the obvious way of starting
 * a .bat file. So these run real scripts from a folder with a space in it.
 */

const onWindows = process.platform === 'win32';

function script(dir: string, name: string, windows: string[], posix: string[]): string {
  mkdirSync(dir, { recursive: true });
  if (onWindows) {
    const file = join(dir, `${name}.bat`);
    writeFileSync(file, ['@echo off', ...windows, ''].join('\r\n'));
    return file;
  }
  const file = join(dir, name);
  writeFileSync(file, ['#!/bin/sh', ...posix, ''].join('\n'));
  chmodSync(file, 0o755);
  return file;
}

function token(): CancelToken {
  return { cancelled: false, child: null };
}

const spaced = () => join(tempDir('runova-cmd-'), 'with space', 'bin');

describe('runCommand', () => {
  it('runs a script from a folder with a space in its name and reports its lines', async () => {
    const file = script(
      spaced(),
      'flutter',
      ['echo Flutter 3.47.7', 'echo done'],
      ['echo "Flutter 3.47.7"', 'echo done'],
    );
    const lines: string[] = [];

    const result = await runCommand(file, ['--version'], {
      token: token(),
      onLine: (line) => lines.push(line.trim()),
      idleMs: 10_000,
    });

    expect(result).toEqual({ code: 0, cancelled: false, timedOut: false, notFound: false });
    expect(lines).toEqual(['Flutter 3.47.7', 'done']);
  });

  it('passes the arguments through', async () => {
    const file = script(spaced(), 'echoargs', ['echo ARGS: %*'], ['echo "ARGS: $@"']);
    const lines: string[] = [];

    await runCommand(file, ['--version', 'a b'], {
      token: token(),
      onLine: (line) => lines.push(line),
      idleMs: 10_000,
    });

    expect(lines.join('\n')).toContain('--version');
    expect(lines.join('\n')).toContain('a b');
  });

  it('reports a failing exit code', async () => {
    const file = script(spaced(), 'fails', ['exit /b 3'], ['exit 3']);

    const result = await runCommand(file, [], {
      token: token(),
      onLine: () => undefined,
      idleMs: 10_000,
    });

    expect(result).toMatchObject({ code: 3, timedOut: false, notFound: false });
  });

  it('reads lines even when output arrives with carriage returns, as progress bars do', async () => {
    const file = script(
      spaced(),
      'bar',
      ['echo step one', 'echo step two'],
      ['printf "step one\\rstep two\\n"'],
    );
    const lines: string[] = [];

    await runCommand(file, [], {
      token: token(),
      onLine: (line) => lines.push(line.trim()),
      idleMs: 10_000,
    });

    expect(lines).toEqual(['step one', 'step two']);
  });

  it('says so when the command does not exist', async () => {
    const result = await runCommand(join(spaced(), 'nothing-here'), [], {
      token: token(),
      onLine: () => undefined,
      idleMs: 10_000,
    });

    expect(result.notFound || result.code !== 0).toBe(true);
    expect(result.cancelled).toBe(false);
  });

  it('stops a command that goes quiet for too long, and says it timed out', async () => {
    const file = script(spaced(), 'hangs', ['ping -n 30 127.0.0.1 >nul'], ['sleep 30']);
    const started = Date.now();

    const result = await runCommand(file, [], {
      token: token(),
      onLine: () => undefined,
      idleMs: 500,
    });

    expect(result.timedOut).toBe(true);
    expect(Date.now() - started).toBeLessThan(15_000);
  });

  it('keeps a command alive while it keeps printing, even past the idle limit in total', async () => {
    const file = script(
      spaced(),
      'chatty',
      [
        'echo one',
        'ping -n 2 127.0.0.1 >nul',
        'echo two',
        'ping -n 2 127.0.0.1 >nul',
        'echo three',
      ],
      ['echo one', 'sleep 1', 'echo two', 'sleep 1', 'echo three'],
    );
    const lines: string[] = [];

    const result = await runCommand(file, [], {
      token: token(),
      onLine: (line) => lines.push(line.trim()),
      idleMs: 1_800,
    });

    expect(result).toMatchObject({ code: 0, timedOut: false });
    expect(lines).toEqual(['one', 'two', 'three']);
  });

  it("is stopped by the run's cancel token", async () => {
    const file = script(spaced(), 'hangs', ['ping -n 30 127.0.0.1 >nul'], ['sleep 30']);
    const cancel = token();
    const pending = runCommand(file, [], {
      token: cancel,
      onLine: () => undefined,
      idleMs: 60_000,
    });

    await new Promise((resolve) => setTimeout(resolve, 600));
    cancel.cancelled = true;
    const { killProcessTree } = await import('../../process/spawnStreaming');
    if (cancel.child) killProcessTree(cancel.child);
    const result = await pending;

    expect(result.cancelled).toBe(true);
  });
});
