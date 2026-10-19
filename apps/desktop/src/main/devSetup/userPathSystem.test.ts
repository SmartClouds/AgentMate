import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir } from '../../test/main/fixtures';

/**
 * The real-machine side of the PATH edit. The logic is covered in userPath.test.ts; this pins the
 * exact commands, because a wrong registry key or a missing /t would write the wrong thing
 * somewhere a person cannot easily see.
 */

type ExecCallback = (error: Error | null, stdout: string, stderr: string) => void;
const exec = vi.hoisted(() => ({ execFile: vi.fn() }));
vi.mock('node:child_process', () => ({ execFile: exec.execFile }));

function answer(stdout: string, error: Error | null = null): void {
  exec.execFile.mockImplementation(
    (_file: string, _args: string[], _options: unknown, callback: ExecCallback) => {
      callback(error, stdout, '');
    },
  );
}

const originalPath = process.env.PATH;
const pathKey = Object.keys(process.env).find((key) => key.toUpperCase() === 'PATH') ?? 'PATH';

beforeEach(() => {
  vi.resetModules();
  exec.execFile.mockReset();
});

afterEach(() => {
  process.env[pathKey] = originalPath;
});

async function deps() {
  const { createSystemUserPathDeps } = await import('./userPathSystem');
  return createSystemUserPathDeps('C:\\Users\\me', 'win32');
}

describe('the Windows registry commands', () => {
  it('reads the user PATH from HKCU\\Environment, and returns it raw', async () => {
    answer(
      '\r\nHKEY_CURRENT_USER\\Environment\r\n    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\x\r\n',
    );

    const value = await (await deps()).readRegistryPath();

    expect(value).toBe('%USERPROFILE%\\bin;C:\\x');
    const [file, args] = exec.execFile.mock.calls[0] ?? [];
    expect(file).toBe('reg.exe');
    expect(args).toEqual(['query', 'HKCU\\Environment', '/v', 'Path']);
  });

  it('treats a missing value as no PATH, once it has checked the key itself can be read', async () => {
    exec.execFile.mockImplementation(
      (_file: string, args: string[], _options: unknown, callback: ExecCallback) => {
        if (args.includes('/v')) {
          const missing = Object.assign(new Error('unable to find the specified registry value'), {
            code: 1,
          });
          callback(missing, '', '');
        } else {
          callback(null, 'HKEY_CURRENT_USER\\Environment\r\n', '');
        }
      },
    );

    expect(await (await deps()).readRegistryPath()).toBeNull();
    expect(exec.execFile.mock.calls.map((call) => call[1])).toEqual([
      ['query', 'HKCU\\Environment', '/v', 'Path'],
      ['query', 'HKCU\\Environment'],
    ]);
  });

  it('does not take a read that failed for any other reason as "no PATH", which would write over it', async () => {
    const timedOut = Object.assign(new Error('Command failed'), { killed: true, code: null });
    const notStarted = Object.assign(new Error('spawn reg.exe ENOENT'), { code: 'ENOENT' });
    const blocked = Object.assign(new Error('Access is denied.'), { code: 1 });

    for (const failure of [timedOut, notStarted]) {
      answer('', failure);
      await expect((await deps()).readRegistryPath()).rejects.toThrow(failure.message);
    }

    // The value looks missing, but the key cannot be read either, so nothing is known about it.
    answer('', blocked);
    await expect((await deps()).readRegistryPath()).rejects.toThrow('Access is denied.');
  });

  it('writes it back as an expandable string, so references like %JAVA_HOME% keep working', async () => {
    answer('The operation completed successfully.');

    await (await deps()).writeRegistryPath('%JAVA_HOME%\\bin;C:\\Program Files\\x');

    const [file, args] = exec.execFile.mock.calls[0] ?? [];
    expect(file).toBe('reg.exe');
    expect(args).toEqual([
      'add',
      'HKCU\\Environment',
      '/v',
      'Path',
      '/t',
      'REG_EXPAND_SZ',
      '/d',
      '%JAVA_HOME%\\bin;C:\\Program Files\\x',
      '/f',
    ]);
  });

  it('says so when the write fails, rather than carrying on as if it worked', async () => {
    answer('', new Error('Access is denied.'));

    await expect((await deps()).writeRegistryPath('C:\\x')).rejects.toThrow('Access is denied.');
  });

  it('tells Windows the environment changed using a fixed script, with nothing from the PATH in it', async () => {
    answer('');

    await (await deps()).broadcastEnvironmentChange();

    const [file, args] = exec.execFile.mock.calls[0] ?? [];
    expect(file).toBe('powershell.exe');
    expect(args.slice(0, 3)).toEqual(['-NoProfile', '-NonInteractive', '-Command']);
    const script = String(args.at(-1));
    expect(script).toContain('SendMessageTimeout');
    expect(script).toContain("'Environment'");
    expect(script).not.toContain('%');
  });
});

describe('the shell startup file', () => {
  it('reads it, and says it is missing only when it is', async () => {
    const dir = tempDir('agentmate-startup-');
    writeFileSync(join(dir, '.zshrc'), 'export A=1\n');
    const d = await deps();

    expect(await d.readFile(join(dir, '.zshrc'))).toBe('export A=1\n');
    expect(await d.readFile(join(dir, '.profile'))).toBeNull();
  });

  it('does not call a file it could not read an empty one, which would be written over', async () => {
    // A folder in the file's place fails to read with something other than "not found".
    const dir = tempDir('agentmate-startup-');
    mkdirSync(join(dir, '.zshrc'));

    await expect((await deps()).readFile(join(dir, '.zshrc'))).rejects.toThrow();
  });
});

describe("this app's own PATH", () => {
  it('gains the folder, once, and keeps what it had', async () => {
    // Folders the way this OS spells them: off Windows the colon in C:\ is the PATH separator.
    const onWindows = process.platform === 'win32';
    const existing = onWindows ? 'C:\\Existing' : '/existing';
    process.env[pathKey] = existing;
    const d = await deps();

    const added = onWindows
      ? ['C:\\New\\bin', 'C:\\New\\bin', 'c:\\new\\bin\\']
      : ['/new/bin', '/new/bin', '/new/bin/'];
    for (const dir of added) d.addToProcessPath(dir);

    const entries = (process.env[pathKey] ?? '').split(onWindows ? ';' : ':');
    const prefix = onWindows ? 'c:\\new' : '/new';
    expect(entries.filter((entry) => entry.toLowerCase().startsWith(prefix)).length).toBe(1);
    expect(entries).toContain(existing);
  });
});
