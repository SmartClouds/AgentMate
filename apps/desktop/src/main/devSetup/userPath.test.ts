import { describe, expect, it, vi } from 'vitest';
import { addToUserPath, parseRegistryPath, type UserPathDeps } from './userPath';

/**
 * Putting a folder on the user's PATH is the one place Dev Setup edits something outside its own
 * files, so it is held to account. Existing entries must survive untouched (including ones that
 * refer to other variables), a folder must never be added twice, and a path that could break the
 * line it is written into is refused.
 */

function windows(initial: string | null, overrides: Partial<UserPathDeps> = {}) {
  let stored = initial;
  const written: string[] = [];
  const deps: UserPathDeps = {
    os: 'win32',
    home: 'C:\\Users\\me',
    readRegistryPath: vi.fn(async () => stored),
    writeRegistryPath: vi.fn(async (value: string) => {
      stored = value;
      written.push(value);
    }),
    broadcastEnvironmentChange: vi.fn(async () => undefined),
    addToProcessPath: vi.fn(),
    readFile: vi.fn(async () => null),
    writeFile: vi.fn(async () => undefined),
    ...overrides,
  };
  return { deps, written, stored: () => stored };
}

function posix(
  os: 'darwin' | 'linux',
  files: Record<string, string> = {},
  shell = '/bin/zsh',
  overrides: Partial<UserPathDeps> = {},
) {
  const fs = new Map(Object.entries(files));
  const deps: UserPathDeps = {
    os,
    home: os === 'darwin' ? '/Users/me' : '/home/me',
    shell,
    readRegistryPath: vi.fn(async () => null),
    writeRegistryPath: vi.fn(async () => undefined),
    broadcastEnvironmentChange: vi.fn(async () => undefined),
    addToProcessPath: vi.fn(),
    readFile: vi.fn(async (path: string) => fs.get(path) ?? null),
    writeFile: vi.fn(async (path: string, text: string) => {
      fs.set(path, text);
    }),
    ...overrides,
  };
  return { deps, fs };
}

const FLUTTER_BIN = 'C:\\Users\\me\\develop\\flutter\\bin';

describe('addToUserPath on Windows', () => {
  it('adds the folder to the end of the user PATH, keeping every existing entry exactly', async () => {
    const existing = '%USERPROFILE%\\AppData\\Local\\Microsoft\\WindowsApps;C:\\Tools\\bin';
    const w = windows(existing);

    const result = await addToUserPath(FLUTTER_BIN, w.deps);

    expect(result).toEqual({ changed: true, where: 'your user PATH' });
    expect(w.written).toEqual([`${existing};${FLUTTER_BIN}`]);
  });

  it('keeps an entry that refers to another variable as that reference, not its current value', async () => {
    const w = windows('%JAVA_HOME%\\bin');

    await addToUserPath(FLUTTER_BIN, w.deps);

    expect(w.written[0]).toContain('%JAVA_HOME%\\bin');
  });

  it('starts a PATH when the user has none', async () => {
    const w = windows(null);

    await addToUserPath(FLUTTER_BIN, w.deps);

    expect(w.written).toEqual([FLUTTER_BIN]);
  });

  it('does not leave an empty entry when the old PATH ended in a semicolon', async () => {
    const w = windows('C:\\Tools\\bin;');

    await addToUserPath(FLUTTER_BIN, w.deps);

    expect(w.written).toEqual([`C:\\Tools\\bin;${FLUTTER_BIN}`]);
  });

  it('does not add a folder that is already there, however it is written', async () => {
    for (const existing of [
      FLUTTER_BIN,
      `${FLUTTER_BIN}\\`,
      FLUTTER_BIN.toLowerCase(),
      `C:\\Tools;${FLUTTER_BIN.toUpperCase()}`,
    ]) {
      const w = windows(existing);

      const result = await addToUserPath(FLUTTER_BIN, w.deps);

      expect(result.changed, existing).toBe(false);
      expect(w.written, existing).toEqual([]);
    }
  });

  it('still puts the folder on the PATH this app is running with, even if it was already saved', async () => {
    const w = windows(FLUTTER_BIN);

    await addToUserPath(FLUTTER_BIN, w.deps);

    expect(w.deps.addToProcessPath).toHaveBeenCalledWith(FLUTTER_BIN);
  });

  it('tells Windows the environment changed, so new programs see it', async () => {
    const w = windows('C:\\Tools');

    await addToUserPath(FLUTTER_BIN, w.deps);

    expect(w.deps.broadcastEnvironmentChange).toHaveBeenCalledTimes(1);
    // After the write, never before it.
    const writeOrder = vi.mocked(w.deps.writeRegistryPath).mock.invocationCallOrder[0] ?? 0;
    const broadcastOrder =
      vi.mocked(w.deps.broadcastEnvironmentChange).mock.invocationCallOrder[0] ?? 0;
    expect(broadcastOrder).toBeGreaterThan(writeOrder);
  });

  it('carries on if the broadcast fails, since the change is saved either way', async () => {
    const w = windows('C:\\Tools', {
      broadcastEnvironmentChange: vi.fn(async () => {
        throw new Error('powershell is not available');
      }),
    });

    await expect(addToUserPath(FLUTTER_BIN, w.deps)).resolves.toMatchObject({ changed: true });
  });

  it('refuses to rewrite a PATH that holds a quote, rather than risk damaging it', async () => {
    const w = windows('"C:\\Program Files\\Odd Tool";C:\\Tools');

    await expect(addToUserPath(FLUTTER_BIN, w.deps)).rejects.toThrow(
      'Your PATH has an entry in quotes, which this cannot safely rewrite. Add the folder by hand.',
    );
    expect(w.written).toEqual([]);
  });

  it('does not touch a file on Windows', async () => {
    const w = windows('C:\\Tools');

    await addToUserPath(FLUTTER_BIN, w.deps);

    expect(w.deps.writeFile).not.toHaveBeenCalled();
  });

  it.each([
    ['a quote', 'C:\\Tools"bin'],
    ['a semicolon, which would split it in two', 'C:\\Tools;evil'],
    ['a line break', 'C:\\Tools\nbin'],
    ['a percent sign, which would expand', 'C:\\%TEMP%\\bin'],
    ['nothing', ''],
    ['a relative path', 'develop\\flutter\\bin'],
  ])('refuses a folder with %s', async (_label, dir) => {
    const w = windows('C:\\Tools');

    await expect(addToUserPath(dir, w.deps)).rejects.toThrow('That folder cannot go on the PATH.');
    expect(w.written).toEqual([]);
  });
});

describe('addToUserPath on macOS and Linux', () => {
  const BIN = '/Users/me/develop/flutter/bin';

  it("adds a marked block to the shell's startup file, written with $HOME", async () => {
    const p = posix('darwin');

    const result = await addToUserPath(BIN, p.deps);

    expect(result).toEqual({ changed: true, where: '/Users/me/.zshrc' });
    expect(p.fs.get('/Users/me/.zshrc')).toBe(
      [
        '',
        '# >>> Runova Dev Setup: /Users/me/develop/flutter/bin >>>',
        'export PATH="$HOME/develop/flutter/bin:$PATH"',
        '# <<< Runova Dev Setup <<<',
        '',
      ].join('\n'),
    );
  });

  it('keeps what is already in the file and adds after it', async () => {
    const p = posix('darwin', { '/Users/me/.zshrc': 'alias ll="ls -l"\n' });

    await addToUserPath(BIN, p.deps);

    expect(p.fs.get('/Users/me/.zshrc')?.startsWith('alias ll="ls -l"\n')).toBe(true);
    expect(p.fs.get('/Users/me/.zshrc')).toContain('export PATH="$HOME/develop/flutter/bin:$PATH"');
  });

  it('adds a missing final newline before its own block, so it does not run into the last line', async () => {
    const p = posix('darwin', { '/Users/me/.zshrc': 'alias ll="ls -l"' });

    await addToUserPath(BIN, p.deps);

    expect(p.fs.get('/Users/me/.zshrc')).toContain('alias ll="ls -l"\n');
    expect(p.fs.get('/Users/me/.zshrc')).not.toContain('alias ll="ls -l"\n\n\n');
  });

  it('does nothing the second time', async () => {
    const p = posix('darwin');
    await addToUserPath(BIN, p.deps);
    const once = p.fs.get('/Users/me/.zshrc');

    const again = await addToUserPath(BIN, p.deps);

    expect(again.changed).toBe(false);
    expect(p.fs.get('/Users/me/.zshrc')).toBe(once);
  });

  it('renames a block written before the app was renamed instead of adding a second one', async () => {
    const other = '/Users/me/Android/Sdk/platform-tools';
    const before = [
      'alias ll="ls -l"',
      `# >>> AgentMate Dev Setup: ${other} >>>`, // legacy-name
      'export PATH="$HOME/Android/Sdk/platform-tools:$PATH"',
      '# <<< AgentMate Dev Setup <<<', // legacy-name
      `# >>> AgentMate Dev Setup: ${BIN} >>>`, // legacy-name
      'export PATH="$HOME/develop/flutter/bin:$PATH"',
      '# <<< AgentMate Dev Setup <<<', // legacy-name
      '',
    ].join('\n');
    const p = posix('darwin', { '/Users/me/.zshrc': before });

    const result = await addToUserPath(BIN, p.deps);

    expect(result.changed).toBe(false);
    const text = p.fs.get('/Users/me/.zshrc') ?? '';
    expect(text.match(/develop\/flutter\/bin:\$PATH/g)).toHaveLength(1);
    expect(text).toContain(`# >>> Runova Dev Setup: ${BIN} >>>`);
    // Only that folder's block is renamed; the other one waits for its own turn.
    expect(text).toContain(`# >>> AgentMate Dev Setup: ${other} >>>`); // legacy-name
    expect(text.match(/# <<< Runova Dev Setup <<</g)).toHaveLength(1);
  });

  it('adds a different folder alongside the first, each marked on its own', async () => {
    const p = posix('darwin');
    await addToUserPath(BIN, p.deps);

    await addToUserPath('/Users/me/Android/Sdk/platform-tools', p.deps);

    const text = p.fs.get('/Users/me/.zshrc') ?? '';
    expect(text.match(/>>> Runova Dev Setup/g)).toHaveLength(2);
  });

  it('picks the startup file for the shell in use', async () => {
    expect((await addToUserPath('/home/me/bin', posix('linux', {}, '/bin/bash').deps)).where).toBe(
      '/home/me/.bashrc',
    );
    expect(
      (await addToUserPath('/home/me/bin', posix('linux', {}, '/usr/bin/zsh').deps)).where,
    ).toBe('/home/me/.zshrc');
    expect(
      (await addToUserPath('/home/me/bin', posix('linux', {}, '/usr/bin/fish').deps)).where,
    ).toBe('/home/me/.profile');
    expect((await addToUserPath('/home/me/bin', posix('linux', {}, '').deps)).where).toBe(
      '/home/me/.profile',
    );
  });

  it('writes a folder outside the home folder as it is', async () => {
    const p = posix('linux', {}, '/bin/bash');

    await addToUserPath('/opt/flutter/bin', p.deps);

    expect(p.fs.get('/home/me/.bashrc')).toContain('export PATH="/opt/flutter/bin:$PATH"');
  });

  it("puts the folder on this app's own PATH too", async () => {
    const p = posix('darwin');

    await addToUserPath(BIN, p.deps);

    expect(p.deps.addToProcessPath).toHaveBeenCalledWith(BIN);
  });

  it('does not touch the registry', async () => {
    const p = posix('darwin');

    await addToUserPath(BIN, p.deps);

    expect(p.deps.writeRegistryPath).not.toHaveBeenCalled();
  });

  it.each([
    ['a quote', '/Users/me/a"b'],
    ['a dollar sign', '/Users/me/$HOME/bin'],
    ['a backtick', '/Users/me/`id`/bin'],
    ['a backslash', '/Users/me/a\\b'],
    ['a line break', '/Users/me/a\nb'],
    ['a relative path', 'develop/flutter/bin'],
  ])('refuses a folder with %s, since it goes into a shell script', async (_label, dir) => {
    const p = posix('darwin');

    await expect(addToUserPath(dir, p.deps)).rejects.toThrow('That folder cannot go on the PATH.');
    expect(p.deps.writeFile).not.toHaveBeenCalled();
  });
});

describe('parseRegistryPath', () => {
  it('reads the value reg.exe prints, leaving references to other variables as they are', () => {
    const output = [
      '',
      'HKEY_CURRENT_USER\\Environment',
      '    Path    REG_EXPAND_SZ    %USERPROFILE%\\bin;C:\\Tools\\bin',
      '',
    ].join('\r\n');

    expect(parseRegistryPath(output)).toBe('%USERPROFILE%\\bin;C:\\Tools\\bin');
  });

  it('reads a plain string value too', () => {
    expect(parseRegistryPath('    Path    REG_SZ    C:\\Tools\\bin\r\n')).toBe('C:\\Tools\\bin');
  });

  it('keeps a value with spaces in it whole', () => {
    expect(
      parseRegistryPath('    Path    REG_EXPAND_SZ    C:\\Program Files\\Git\\cmd;C:\\x\r\n'),
    ).toBe('C:\\Program Files\\Git\\cmd;C:\\x');
  });

  it('is null when there is no Path value', () => {
    expect(parseRegistryPath('')).toBeNull();
    expect(
      parseRegistryPath('ERROR: The system was unable to find the specified registry key'),
    ).toBeNull();
  });

  it('is null for an empty value, so a new one is written rather than ";" appended to nothing', () => {
    expect(parseRegistryPath('    Path    REG_EXPAND_SZ    \r\n')).toBeNull();
  });
});
