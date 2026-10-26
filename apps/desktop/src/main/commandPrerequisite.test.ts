import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  checkCommandPrerequisite,
  prerequisiteCandidates,
  programOf,
  splitStatements,
} from './commandPrerequisite';

/**
 * An install command typed into a terminal on a machine without Node.js fails with "npm is not
 * recognized", which reads like Runova is broken. These pin how the program a command needs
 * is read out of it, and that only a missing one is reported.
 */

const present = vi.hoisted(() => new Set<string>());
vi.mock('./installMethod', () => ({
  resolveExecutable: async (names: string[]) =>
    names.some((name) => present.has(name)) ? `/usr/bin/${names[0]}` : null,
}));
vi.mock('./windowsPath', () => ({ refreshWindowsPath: vi.fn(async () => undefined) }));

beforeEach(() => {
  present.clear();
});

describe('splitStatements', () => {
  it('splits on ; && || and newlines', () => {
    expect(splitStatements('a; b && c || d\ne')).toEqual(['a', 'b', 'c', 'd', 'e']);
  });

  it('leaves separators inside quotes alone', () => {
    // The Semgrep command on Windows sets PATH first, with a value full of semicolons.
    const command =
      "[System.Environment]::SetEnvironmentVariable('Path', $env:Path + ';C:\\x;C:\\y', 'User'); pipx install semgrep";

    expect(splitStatements(command)).toEqual([
      "[System.Environment]::SetEnvironmentVariable('Path', $env:Path + ';C:\\x;C:\\y', 'User')",
      'pipx install semgrep',
    ]);
  });
});

describe('programOf', () => {
  it('lowercases, drops the Windows extension and skips sudo', () => {
    expect(programOf('NPM.cmd install -g x')).toBe('npm');
    expect(programOf('sudo npm install -g x')).toBe('npm');
    expect(programOf('  python3 -m pip install x')).toBe('python3');
  });
});

describe('prerequisiteCandidates', () => {
  it('maps the package managers to what provides them', () => {
    const names = (command: string) =>
      prerequisiteCandidates(command).map((one) => one.prerequisite.name);

    expect(names('npm install -g @anthropic-ai/claude-code')).toEqual(['Node.js']);
    expect(names('npx -y something')).toEqual(['Node.js']);
    expect(names('pipx install semgrep')).toEqual(['pipx']);
    expect(names('python -m pip install aider-chat')).toEqual(['Python']);
    expect(names('pip3 install x')).toEqual(['Python']);
    expect(names('py -m pip install x')).toEqual(['Python']);
    expect(names('brew install gemini-cli')).toEqual(['Homebrew']);
    expect(names('winget install Microsoft.Git')).toEqual(['WinGet (App Installer)']);
    expect(names('cargo install x')).toEqual(['Rust']);
  });

  it('asks nothing of a vendor install script, since curl and irm come with the OS', () => {
    expect(prerequisiteCandidates('curl -fsSL https://claude.ai/install.sh | bash')).toEqual([]);
    expect(prerequisiteCandidates('irm https://claude.ai/install.ps1 | iex')).toEqual([]);
    expect(prerequisiteCandidates('powershell -c "irm x | iex"')).toEqual([]);
  });

  it('looks past a first statement that needs nothing', () => {
    const command =
      "[System.Environment]::SetEnvironmentVariable('PYTHONUTF8', '1', 'User'); pipx install semgrep";

    expect(prerequisiteCandidates(command).map((one) => one.program)).toEqual(['pipx']);
  });

  it('lists each program once, in the order they run', () => {
    expect(
      prerequisiteCandidates('npm i -g a && pipx install b; npm i -g c').map((one) => one.program),
    ).toEqual(['npm', 'pipx']);
  });

  it('does not treat Object.prototype names as programs', () => {
    expect(prerequisiteCandidates('constructor --x')).toEqual([]);
  });
});

describe('checkCommandPrerequisite', () => {
  it('names what is missing, with where to get it', async () => {
    await expect(checkCommandPrerequisite('npm install -g x')).resolves.toEqual({
      name: 'Node.js',
      url: 'https://nodejs.org/en/download',
    });
  });

  it('answers null when the program is installed', async () => {
    present.add('npm');

    await expect(checkCommandPrerequisite('npm install -g x')).resolves.toBeNull();
  });

  it('reports the first missing one when a command needs several', async () => {
    present.add('npm');

    await expect(checkCommandPrerequisite('npm i -g a; pipx install b')).resolves.toMatchObject({
      name: 'pipx',
    });
  });

  it('answers null for a command that needs nothing', async () => {
    await expect(checkCommandPrerequisite('curl -fsSL https://x | bash')).resolves.toBeNull();
  });
});
