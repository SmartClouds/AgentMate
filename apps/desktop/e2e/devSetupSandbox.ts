import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/**
 * A private set of developer tools for the Dev Setup tests. The app is pointed at this folder
 * (AGENTMATE_DEVSETUP_SANDBOX), which replaces its PATH, home and Program Files while it looks for
 * tools, so a test sees exactly what is here and never what the machine running it has installed.
 *
 * The tools are scripts that print what the real ones print. `winget` is a script too: it logs how
 * it was called, can be told to fail once or to take a long time, and installs a fake `gh` by
 * writing one into the folder, which is what lets a whole install run end to end.
 */

const onWindows = process.platform === 'win32';

export interface DevSetupSandbox {
  folder: string;
  bin: string;
  /** Environment for `launchApp({ env })`. */
  env(): Record<string, string>;
  /** Every line winget was called with, quotes removed. */
  wingetCalls(): string[];
  /** The next winget install fails once with Windows Installer's "fatal error" code. */
  failNextInstall(): void;
  /** Installs take about forty seconds, so a test has time to cancel one. */
  makeInstallsSlow(): void;
  cleanup(): void;
}

function writeTool(bin: string, name: string, windows: string[], posix: string[]): void {
  if (onWindows) {
    writeFileSync(join(bin, `${name}.cmd`), ['@echo off', ...windows, ''].join('\r\n'));
    return;
  }
  const file = join(bin, name);
  writeFileSync(file, ['#!/bin/sh', ...posix, ''].join('\n'));
  chmodSync(file, 0o755);
}

export function createDevSetupSandbox(): DevSetupSandbox {
  const folder = mkdtempSync(join(tmpdir(), 'agentmate-devsetup-'));
  const bin = join(folder, 'bin');
  mkdirSync(bin, { recursive: true });

  // What the machine already has: Git, Node.js and npm. The GitHub CLI is missing on purpose.
  writeTool(bin, 'git', ['echo git version 2.55.0.windows.1'], ['echo "git version 2.55.0"']);
  writeTool(bin, 'node', ['echo v22.12.0'], ['echo "v22.12.0"']);
  writeTool(bin, 'npm', ['echo 10.9.0'], ['echo "10.9.0"']);

  // The package manager the GitHub CLI's one-click install goes through on Linux. The sandbox's
  // PATH has no system folders, so without this the row would only offer the manual steps.
  if (process.platform === 'linux') {
    writeTool(bin, 'apt-get', [], ['echo "apt 2.7.14 (amd64)"']);
  }

  if (onWindows) {
    writeTool(
      bin,
      'winget',
      [
        'setlocal',
        'if "%~1"=="--version" goto version',
        '>>"%~dp0winget.log" echo %*',
        'if exist "%~dp0fail-once" goto fail',
        'echo Found GitHub CLI [GitHub.cli] Version 2.62.0',
        'echo Downloading https://github.com/cli/cli/releases/download/v2.62.0/gh.msi',
        'echo   40%%',
        'if exist "%~dp0slow" ping -n 40 127.0.0.1 >nul',
        'ping -n 2 127.0.0.1 >nul',
        'echo Successfully verified installer hash',
        'echo Starting package install...',
        '>"%~dp0gh.cmd" echo @echo off',
        '>>"%~dp0gh.cmd" echo echo gh version 2.62.0',
        'echo Successfully installed',
        'exit /b 0',
        ':fail',
        'del "%~dp0fail-once"',
        'echo Found GitHub CLI [GitHub.cli] Version 2.62.0',
        'echo Installer failed with exit code 1603',
        'exit /b 1603',
        ':version',
        'echo v1.9.25200',
        'exit /b 0',
      ],
      [],
    );
  }

  return {
    folder,
    bin,
    env: () => ({ AGENTMATE_DEVSETUP_SANDBOX: folder }),
    wingetCalls: () => {
      const log = join(bin, 'winget.log');
      if (!existsSync(log)) return [];
      return readFileSync(log, 'utf-8')
        .split(/\r?\n/)
        .map((line) => line.replaceAll('"', '').trim())
        .filter(Boolean);
    },
    failNextInstall: () => writeFileSync(join(bin, 'fail-once'), ''),
    makeInstallsSlow: () => writeFileSync(join(bin, 'slow'), ''),
    cleanup: () => {
      try {
        rmSync(folder, { recursive: true, force: true, maxRetries: 10, retryDelay: 300 });
      } catch {
        // A process that was slow to exit can still hold the folder; it lives in the temp dir.
      }
    },
  };
}
