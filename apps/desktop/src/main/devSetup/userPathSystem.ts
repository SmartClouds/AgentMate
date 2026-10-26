import { execFile } from 'node:child_process';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { delimiter, dirname } from 'node:path';
import type { DevOs } from '@runova/core';
import { pathKey } from '../windowsPath';
import { parseRegistryPath, type UserPathDeps } from './userPath';

/**
 * The real-machine side of `addToUserPath`: the registry commands, the broadcast, and the files.
 * Kept this thin on purpose; the decisions are in userPath.ts and the commands are pinned by test.
 */

const USER_ENV = 'HKCU\\Environment';

/** Asks Windows to tell running programs that the environment changed. A fixed script. */
const BROADCAST_SCRIPT = [
  'Add-Type -Namespace Win32 -Name Native -MemberDefinition \'[DllImport("user32.dll", SetLastError=true, CharSet=CharSet.Auto)] public static extern IntPtr SendMessageTimeout(IntPtr hWnd, uint Msg, UIntPtr wParam, string lParam, uint fuFlags, uint uTimeout, out UIntPtr lpdwResult);\'',
  '$result = [UIntPtr]::Zero',
  "[void][Win32.Native]::SendMessageTimeout([IntPtr]0xffff, 0x1A, [UIntPtr]::Zero, 'Environment', 2, 5000, [ref]$result)",
].join('; ');

function run(file: string, args: string[], timeout = 10_000): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(file, args, { windowsHide: true, timeout }, (error, stdout) => {
      if (error) reject(error);
      else resolve(stdout);
    });
  });
}

/** A reg.exe that ran and reported failure (exit code 1), as opposed to one that timed out or never started. */
function isReg1(error: unknown): boolean {
  const failure = error as { code?: unknown; killed?: unknown };
  return failure.code === 1 && failure.killed !== true;
}

export function createSystemUserPathDeps(
  home: string,
  os: DevOs = process.platform === 'win32'
    ? 'win32'
    : process.platform === 'darwin'
      ? 'darwin'
      : 'linux',
): UserPathDeps {
  return {
    os,
    home,
    shell: process.env.SHELL,
    readRegistryPath: async () => {
      try {
        return parseRegistryPath(await run('reg.exe', ['query', USER_ENV, '/v', 'Path']));
      } catch (error) {
        // A timeout or a reg.exe that would not start says nothing about the PATH, and treating it
        // as empty would write a PATH with only the new folder over the real one.
        if (!isReg1(error)) throw error;
        // reg.exe exits with 1 for every failure, so a missing value is told apart from a key that
        // cannot be read by reading the key itself. No Path value is a normal state for a new account.
        await run('reg.exe', ['query', USER_ENV]);
        return null;
      }
    },
    writeRegistryPath: async (value) => {
      // REG_EXPAND_SZ keeps %VAR% entries working; an argv array means no shell reads the value.
      await run('reg.exe', [
        'add',
        USER_ENV,
        '/v',
        'Path',
        '/t',
        'REG_EXPAND_SZ',
        '/d',
        value,
        '/f',
      ]);
    },
    broadcastEnvironmentChange: async () => {
      await run(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', BROADCAST_SCRIPT],
        15_000,
      );
    },
    addToProcessPath: (dir) => {
      const key = pathKey(process.env);
      const entries = (process.env[key] ?? '').split(delimiter).filter(Boolean);
      const normalize = (entry: string): string => entry.replace(/[\\/]+$/, '').toLowerCase();
      if (entries.some((entry) => normalize(entry) === normalize(dir))) return;
      process.env[key] = [...entries, dir].join(delimiter);
    },
    readFile: async (path) => {
      try {
        return await readFile(path, 'utf-8');
      } catch (error) {
        // Only a file that is not there counts as empty. Any other failure must not end up with the
        // startup file rewritten from nothing.
        const code = (error as NodeJS.ErrnoException).code;
        if (code === 'ENOENT' || code === 'ENOTDIR') return null;
        throw error;
      }
    },
    writeFile: async (path, text) => {
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, text, 'utf-8');
    },
  };
}
