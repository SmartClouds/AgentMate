import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../../test/main/fixtures';
import { type CancelToken, spawnStreaming } from '../../process/spawnStreaming';
import { createPackageManagerRunner } from './packageManagerRunner';

// Only the extra tool folders are skipped here (they start Python to look for them).
vi.mock('../../toolPaths', () => ({
  withToolPath: async (env?: NodeJS.ProcessEnv) => ({ ...(env ?? process.env) }),
}));

/**
 * The runner against a real process. The other tests fake `spawn`, which is how a missing working
 * folder went unnoticed: spawning with a folder that does not exist fails with ENOENT, and the
 * shared spawn helper reports that as "command not found". So this runs a real script, called
 * `winget`, through the real spawn path in a folder that exists, and in one that does not.
 */

const onWindows = process.platform === 'win32';

function fakeWinget(dir: string, lines: string[], exitCode: number): void {
  mkdirSync(dir, { recursive: true });
  if (onWindows) {
    writeFileSync(
      join(dir, 'winget.cmd'),
      [
        '@echo off',
        `>>"%~dp0calls.log" echo %*`,
        // A lone % is dropped by cmd, so it is doubled to be printed.
        ...lines.map((line) => `echo ${line.replaceAll('%', '%%')}`),
        `exit /b ${exitCode}`,
        '',
      ].join('\r\n'),
    );
    return;
  }
  const file = join(dir, 'winget');
  writeFileSync(
    file,
    [
      '#!/bin/sh',
      `echo "$@" >> "$(dirname "$0")/calls.log"`,
      ...lines.map((line) => `echo "${line}"`),
      `exit ${exitCode}`,
      '',
    ].join('\n'),
  );
  chmodSync(file, 0o755);
}

function environmentWith(bin: string): NodeJS.ProcessEnv {
  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  const system = onWindows
    ? [join(process.env.SystemRoot ?? 'C:\\Windows', 'System32')]
    : ['/usr/bin', '/bin'];
  return { ...process.env, [key]: [bin, ...system].join(delimiter) };
}

function hooks() {
  const token: CancelToken = { cancelled: false, child: null };
  const progress: unknown[] = [];
  const lines: string[] = [];
  return {
    token,
    progress,
    lines,
    hooks: {
      token,
      onProgress: (update: unknown) => progress.push(update),
      onLine: (line: string) => lines.push(line),
    },
  };
}

const WINGET = { kind: 'winget', id: 'GitHub.cli' } as const;

describe('the runner with a real process', () => {
  it('runs the command it was given, reads its output and succeeds', async () => {
    const bin = join(tempDir('agentmate-runner-'), 'bin');
    fakeWinget(
      bin,
      ['Found GitHub CLI [GitHub.cli] Version 2.62.0', '  40%', 'Successfully installed'],
      0,
    );
    const h = hooks();

    const result = await createPackageManagerRunner({
      spawn: spawnStreaming,
      cwd: tempDir('agentmate-cwd-'),
      env: environmentWith(bin),
    }).run(WINGET, 'install', h.hooks);

    expect(result).toEqual({ ok: true, code: 0, cancelled: false });
    expect(h.lines.map((line) => line.trim())).toEqual([
      'Found GitHub CLI [GitHub.cli] Version 2.62.0',
      '40%',
      'Successfully installed',
    ]);
    expect(h.progress).toContainEqual({ fraction: 0.4, detail: '40%' });
  });

  it('hands the tool the arguments, with no shell between that could change them', async () => {
    const bin = join(tempDir('agentmate-runner-'), 'bin');
    fakeWinget(bin, [], 0);
    const h = hooks();

    await createPackageManagerRunner({
      spawn: spawnStreaming,
      cwd: tempDir('agentmate-cwd-'),
      env: environmentWith(bin),
    }).run(WINGET, 'install', h.hooks);

    const { readFileSync } = await import('node:fs');
    const logged = readFileSync(join(bin, 'calls.log'), 'utf-8').replaceAll('"', '').trim();
    expect(logged).toBe(
      'install --id GitHub.cli --exact --source winget --silent --accept-package-agreements --accept-source-agreements',
    );
  });

  it("turns the tool's exit code into a sentence", async () => {
    const bin = join(tempDir('agentmate-runner-'), 'bin');
    fakeWinget(bin, ['Installer failed with exit code 1603'], 1603);
    const h = hooks();

    const result = await createPackageManagerRunner({
      spawn: spawnStreaming,
      cwd: tempDir('agentmate-cwd-'),
      env: environmentWith(bin),
    }).run(WINGET, 'install', h.hooks);

    // A POSIX exit status is one byte, so the fake's 1603 arrives there as 67.
    const code = process.platform === 'win32' ? 1603 : 1603 % 256;
    expect(result).toMatchObject({
      ok: false,
      code,
      message: `winget could not finish (code ${code}).`,
    });
    expect(h.lines.map((line) => line.trim())).toContain('Installer failed with exit code 1603');
  });

  it('really says the tool is missing when it is', async () => {
    const empty = join(tempDir('agentmate-runner-'), 'bin');
    mkdirSync(empty, { recursive: true });
    const h = hooks();

    const result = await createPackageManagerRunner({
      spawn: spawnStreaming,
      cwd: tempDir('agentmate-cwd-'),
      env: environmentWith(empty),
    }).run(WINGET, 'install', h.hooks);

    expect(result).toMatchObject({ ok: false, message: 'winget was not found on this computer.' });
  });
});
