import { chmodSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { tempDir } from '../../test/main/fixtures';
import {
  killProcessTree,
  probe,
  quoteForCmd,
  type ScanCancelToken,
  spawnScan,
  stripAnsi,
  trimLog,
} from './exec';

/**
 * Runs real child processes rather than mocking node:child_process, because the two things this
 * module adds on top of spawnStreaming are both about what a real process produces: the line
 * trimming, and whether a probe's exit code and stdout come back intact.
 *
 * Scripts go in a temp folder whose path has no spaces. spawnScan and probe both route through
 * `cmd.exe /d /s /c` on Windows with the command left unquoted, so a command path containing a
 * space (`C:\Program Files\...`) cannot be used as a fixture here.
 */

const onWindows = process.platform === 'win32';

/** Writes an executable script that prints `lines` and exits with `code`. */
function script(name: string, lines: string[], code = 0): string {
  const dir = tempDir('runova-exec-');
  if (onWindows) {
    const path = join(dir, `${name}.cmd`);
    const body = ['@echo off', ...lines.map((line) => (line ? `echo ${line}` : 'echo.'))];
    writeFileSync(path, `${body.join('\r\n')}\r\nexit /b ${code}\r\n`, 'utf-8');
    return path;
  }
  const path = join(dir, `${name}.sh`);
  const body = ['#!/bin/sh', ...lines.map((line) => `echo "${line}"`)];
  writeFileSync(path, `${body.join('\n')}\nexit ${code}\n`, 'utf-8');
  chmodSync(path, 0o755);
  return path;
}

function token(): ScanCancelToken {
  return { cancelled: false, child: null };
}

describe('spawnScan', () => {
  it('hands the caller trimmed, non-empty lines', async () => {
    // Scanners indent and pad their progress output, and Semgrep in particular emits blank
    // lines between sections. A log panel showing those verbatim is mostly whitespace.
    const command = script('lines', ['   hello   ', '', 'world']);
    const lines: string[] = [];

    const result = await spawnScan({
      command,
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: token(),
      onLine: (line) => lines.push(line),
    });

    expect(lines).toEqual(['hello', 'world']);
    expect(result.code).toBe(0);
    expect(result.notFound).toBe(false);
    expect(result.timedOut).toBe(false);
    expect(result.cancelled).toBe(false);
  });

  it('keeps the untrimmed text in the log even though the lines are trimmed', async () => {
    const command = script('log', ['  indented  ']);

    const result = await spawnScan({
      command,
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: token(),
    });

    // The raw log is what gets attached to the run record, so indentation has to survive there.
    expect(result.log).toContain('indented');
  });

  it('works without an onLine callback', async () => {
    const command = script('quiet', ['something']);

    const result = await spawnScan({
      command,
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: token(),
    });

    expect(result.code).toBe(0);
    expect(result.log).toContain('something');
  });

  it('reports a non-zero exit without treating it as a missing binary', async () => {
    // Nearly every scanner exits non-zero to mean "found something", so this distinction is
    // what stops a successful scan being reported as a broken install.
    const command = script('found', ['done'], 2);

    const result = await spawnScan({
      command,
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: token(),
    });

    expect(result.code).toBe(2);
    expect(result.notFound).toBe(false);
  });

  it('flags a command that is not installed', async () => {
    const result = await spawnScan({
      command: 'runova-scanner-that-does-not-exist',
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: token(),
    });

    // The UI offers "install it" for this case and "check the log" for a plain failure.
    expect(result.notFound).toBe(true);
  });

  it('returns immediately when the token is already cancelled', async () => {
    const cancelled: ScanCancelToken = { cancelled: true, child: null };

    const result = await spawnScan({
      command: script('never', ['ran']),
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: cancelled,
    });

    // A cancel that lands while PATH is being resolved must not start a scanner nobody awaits.
    expect(result.cancelled).toBe(true);
    expect(result.code).toBeNull();
    expect(result.log).toBe('');
    expect(cancelled.child).toBeNull();
  });

  it('clears the child handle once the run is over', async () => {
    const live = token();

    await spawnScan({
      command: script('short', ['ok']),
      args: [],
      cwd: tempDir(),
      timeoutMs: 15_000,
      token: live,
    });

    // A stale handle would make a later cancel kill an unrelated process by pid.
    expect(live.child).toBeNull();
  });
});

describe('probe', () => {
  it('reports success with the trimmed stdout', async () => {
    const command = script('version', ['tool version 1.2.3']);

    const result = await probe(command, []);

    expect(result.ok).toBe(true);
    // Preflight pulls a version number out of this string, so trailing newlines have to go.
    expect(result.stdout).toBe('tool version 1.2.3');
  });

  it('reports failure for a non-zero exit', async () => {
    const result = await probe(script('broken', ['nope'], 1), []);

    // `docker --version` succeeding while `docker info` fails is exactly this distinction.
    expect(result.ok).toBe(false);
  });

  it('reports failure for a command that is not installed', async () => {
    const result = await probe('runova-tool-that-does-not-exist', ['--version']);

    expect(result.ok).toBe(false);
    expect(result.stdout).toBe('');
  });

  it('passes arguments through to the command', async () => {
    const dir = tempDir('runova-exec-');
    const path = onWindows ? join(dir, 'echoargs.cmd') : join(dir, 'echoargs.sh');
    if (onWindows) {
      writeFileSync(path, '@echo off\r\necho got:%1\r\n', 'utf-8');
    } else {
      writeFileSync(path, '#!/bin/sh\necho "got:$1"\n', 'utf-8');
      chmodSync(path, 0o755);
    }

    const result = await probe(path, ['info']);

    expect(result.ok).toBe(true);
    expect(result.stdout).toBe('got:info');
  });

  it('never rejects, so a preflight check cannot throw', async () => {
    // Preflight runs a dozen of these concurrently and does not catch; one rejection would
    // take down the whole tab rather than marking a single requirement unmet.
    const result = await probe('', []);

    expect(typeof result.ok).toBe('boolean');
    expect(typeof result.stdout).toBe('string');
  });

  it('gives up on a command that never exits', async () => {
    const dir = tempDir('runova-exec-');
    const path = onWindows ? join(dir, 'hang.cmd') : join(dir, 'hang.sh');
    if (onWindows) {
      // `pause` blocks on stdin, which execFile gives no input, so it waits forever.
      writeFileSync(path, '@echo off\r\npause\r\n', 'utf-8');
    } else {
      writeFileSync(path, '#!/bin/sh\nsleep 30\n', 'utf-8');
      chmodSync(path, 0o755);
    }

    // A `docker info` against a wedged daemon hangs rather than failing, and preflight has to
    // come back with an answer either way.
    const result = await probe(path, [], 300);

    expect(result.ok).toBe(false);
  });
});

describe('re-exports', () => {
  it('forwards the shared process helpers', () => {
    // These live in process/spawnStreaming and are re-exported so scan code has one import.
    // Their behaviour is covered there; this only guards the barrel.
    expect(typeof stripAnsi).toBe('function');
    expect(typeof trimLog).toBe('function');
    expect(typeof quoteForCmd).toBe('function');
    expect(typeof killProcessTree).toBe('function');
    expect(stripAnsi('\u001B[31mred\u001B[0m')).toBe('red');
  });
});
