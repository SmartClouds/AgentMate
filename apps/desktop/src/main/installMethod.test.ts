import { chmodSync, mkdirSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { tempDir, writeTree } from '../test/main/fixtures';
import {
  grokInstalledWithNpm,
  installManagerOf,
  reinstallCommandFor,
  resolveExecutable,
  uninstallCommandFor,
  updateCommandFor,
} from './installMethod';

/**
 * The update and uninstall buttons have to talk to whatever owns the copy of a CLI that actually
 * runs. Re-running Claude's install script over an old `npm install -g` copy leaves both on disk
 * with the npm one still first on PATH, so the update looks like it did nothing. These pin how
 * the owner is read off the executable's location and which command that turns into.
 *
 * Folders stand in for the real install layouts; nothing is installed for real.
 */

const extraDirs = vi.hoisted(() => ({ tool: [] as string[], python: [] as string[] }));
vi.mock('./toolPaths', () => ({
  getExtraToolPathDirs: async () => extraDirs.tool,
  pythonScriptDirs: async () => extraDirs.python,
}));

beforeEach(() => {
  extraDirs.tool = [];
  extraDirs.python = [];
});

const pathKey = (): string =>
  Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';

/** An executable file named `name` in `dir`, with the extension Windows needs to find it. */
function writeExecutable(dir: string, name: string): string {
  mkdirSync(dir, { recursive: true });
  const file = join(dir, process.platform === 'win32' ? `${name}.cmd` : name);
  writeFileSync(file, process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n');
  chmodSync(file, 0o755);
  return file;
}

/** Lowercased, since Windows hands back the extension the way PATHEXT spells it (.CMD). */
async function found(name: string): Promise<string | undefined> {
  return (await resolveExecutable([name]))?.toLowerCase();
}

describe('resolveExecutable', () => {
  it('finds a CLI on PATH', async () => {
    const bin = join(tempDir(), 'bin');
    const file = writeExecutable(bin, 'claude');
    vi.stubEnv(pathKey(), bin);

    expect(await found('claude')).toBe(file.toLowerCase());
  });

  it('finds one only a native installer folder has, like ~/.local/bin on a Finder-launched Mac', async () => {
    const localBin = join(tempDir(), '.local', 'bin');
    const file = writeExecutable(localBin, 'claude');
    vi.stubEnv(pathKey(), join(tempDir(), 'empty'));
    extraDirs.tool = [localBin];

    expect(await found('claude')).toBe(file.toLowerCase());
  });

  it('prefers the copy on PATH over one in an extra folder', async () => {
    const onPath = writeExecutable(join(tempDir(), 'bin'), 'claude');
    const extra = join(tempDir(), '.local', 'bin');
    writeExecutable(extra, 'claude');
    vi.stubEnv(pathKey(), join(onPath, '..'));
    extraDirs.tool = [extra];

    expect(await found('claude')).toBe(onPath.toLowerCase());
  });

  it('answers null when nothing by that name exists', async () => {
    vi.stubEnv(pathKey(), join(tempDir(), 'empty'));

    await expect(resolveExecutable(['not-a-real-cli'])).resolves.toBeNull();
  });
});

describe('grokInstalledWithNpm', () => {
  it('reads the installer npm wrote into config.toml', async () => {
    const home = tempDir();
    writeFileSync(join(home, 'config.toml'), '[cli]\ninstaller = "npm"\n\n[ui]\nyolo = false\n');

    await expect(grokInstalledWithNpm(home)).resolves.toBe(true);
  });

  it('is false for a script install or when there is no config yet', async () => {
    const home = tempDir();
    await expect(grokInstalledWithNpm(home)).resolves.toBe(false);

    writeFileSync(join(home, 'config.toml'), '[cli]\ninstaller = "script"\n');
    await expect(grokInstalledWithNpm(home)).resolves.toBe(false);
  });
});

describe('installManagerOf', () => {
  it('reads a Homebrew formula out of a Cellar path', async () => {
    const file = writeExecutable(join(tempDir(), 'Cellar', 'gemini-cli', '0.9.0', 'bin'), 'gemini');

    await expect(installManagerOf(file)).resolves.toEqual({ kind: 'brew', name: 'gemini-cli' });
  });

  it('reads a Homebrew cask out of a Caskroom path', async () => {
    const file = writeExecutable(join(tempDir(), 'Caskroom', 'claude-code', '2.0.1'), 'claude');

    await expect(installManagerOf(file)).resolves.toEqual({ kind: 'brew', name: 'claude-code' });
  });

  it('reads an unscoped npm package out of a node_modules path', async () => {
    const file = writeExecutable(
      join(tempDir(), 'lib', 'node_modules', 'opencode-ai', 'bin'),
      'opencode',
    );

    await expect(installManagerOf(file)).resolves.toEqual({ kind: 'npm', pkg: 'opencode-ai' });
  });

  it('reads a scoped package, and the last node_modules when packages are nested', async () => {
    const file = writeExecutable(
      join(tempDir(), 'lib', 'node_modules', 'wrapper', 'node_modules', '@openai', 'codex', 'bin'),
      'codex',
    );

    await expect(installManagerOf(file)).resolves.toEqual({ kind: 'npm', pkg: '@openai/codex' });
  });

  it('calls an npm global under a Homebrew Node an npm copy', async () => {
    const file = writeExecutable(
      join(tempDir(), 'Cellar', 'node', '22.0.0', 'lib', 'node_modules', '@google', 'gemini-cli'),
      'gemini',
    );

    await expect(installManagerOf(file)).resolves.toEqual({
      kind: 'npm',
      pkg: '@google/gemini-cli',
    });
  });

  it("reads the package out of npm's Windows .cmd shim", async () => {
    // npm on Windows writes claude.cmd, claude.ps1 and an sh script next to node_modules
    // instead of a symlink, so the path alone says nothing. The shim's text names the package.
    const prefix = tempDir();
    writeTree(prefix, {
      'claude.cmd': [
        '@ECHO off',
        'SETLOCAL',
        'SET dp0=%~dp0',
        'IF EXIST "%dp0%\\node.exe" (SET "_prog=%dp0%\\node.exe") ELSE (SET "_prog=node")',
        '"%_prog%"  "%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*',
        '',
      ].join('\r\n'),
      'node_modules/@anthropic-ai/claude-code/cli.js': '',
    });

    await expect(installManagerOf(join(prefix, 'claude.cmd'))).resolves.toEqual({
      kind: 'npm',
      pkg: '@anthropic-ai/claude-code',
    });
  });

  it('reads the package through the extensionless shim npm writes beside it', async () => {
    const prefix = tempDir();
    writeTree(prefix, {
      pi: '#!/bin/sh\nexec node  "$basedir/node_modules/@earendil-works/pi-coding-agent/dist/cli.js" "$@"\n',
      'node_modules/@earendil-works/pi-coding-agent/dist/cli.js': '',
    });

    // Asked about a pi.cmd that is not there, the sibling sh shim still gives the answer.
    await expect(installManagerOf(join(prefix, 'pi.cmd'))).resolves.toEqual({
      kind: 'npm',
      pkg: '@earendil-works/pi-coding-agent',
    });
  });

  it('does not trust a shim whose package is not actually there', async () => {
    const prefix = tempDir();
    writeTree(prefix, {
      'claude.cmd': '"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\cli.js" %*\r\n',
      'node_modules/something-else/index.js': '',
    });

    await expect(installManagerOf(join(prefix, 'claude.cmd'))).resolves.toBeNull();
  });

  it("calls a CLI in Python's Scripts folder a pip copy", async () => {
    const scripts = join(tempDir(), 'Python312', 'Scripts');
    const file = writeExecutable(scripts, 'aider');
    extraDirs.python = [`${scripts}${process.platform === 'win32' ? '\\' : '/'}`];

    await expect(installManagerOf(file)).resolves.toEqual({ kind: 'pip' });
  });

  it('answers null for a native install it knows nothing about', async () => {
    const file = writeExecutable(join(tempDir(), '.local', 'bin'), 'claude');

    await expect(installManagerOf(file)).resolves.toBeNull();
  });

  it.skipIf(process.platform === 'win32')(
    'follows the symlink Homebrew puts in its bin folder',
    async () => {
      const root = tempDir();
      const target = writeExecutable(join(root, 'Caskroom', 'claude-code', '2.0.1'), 'claude');
      mkdirSync(join(root, 'bin'));
      symlinkSync(target, join(root, 'bin', 'claude'));

      await expect(installManagerOf(join(root, 'bin', 'claude'))).resolves.toEqual({
        kind: 'brew',
        name: 'claude-code',
      });
    },
  );

  it.skipIf(process.platform === 'win32')(
    'follows the symlink npm puts in its bin folder on macOS and Linux',
    async () => {
      const root = tempDir();
      const target = join(root, 'lib', 'node_modules', '@qwen-code', 'qwen-code', 'cli.js');
      writeExecutable(join(target, '..'), 'cli.js');
      mkdirSync(join(root, 'bin'));
      symlinkSync(target, join(root, 'bin', 'qwen'));

      await expect(installManagerOf(join(root, 'bin', 'qwen'))).resolves.toEqual({
        kind: 'npm',
        pkg: '@qwen-code/qwen-code',
      });
    },
  );
});

describe('updateCommandFor', () => {
  const npm = (pkg: string) => ({ kind: 'npm', pkg }) as const;

  it("keeps the catalog's command when nobody known owns the copy", () => {
    expect(updateCommandFor({ catalogCommand: 'claude update', manager: null })).toBe(
      'claude update',
    );
    expect(updateCommandFor({ catalogCommand: null, manager: null })).toBeNull();
  });

  it('always goes through Homebrew for a Homebrew copy', () => {
    // A self-updater cannot write over files Homebrew owns, so `claude update` does nothing.
    expect(
      updateCommandFor({
        catalogCommand: 'claude update',
        manager: { kind: 'brew', name: 'claude-code' },
      }),
    ).toBe('brew upgrade claude-code');
  });

  it('swaps an installer re-run for npm when npm owns the copy', () => {
    // Qwen's update is its install script again, which would put a second copy beside npm's.
    expect(
      updateCommandFor({
        catalogCommand:
          'curl -fsSL https://qwen-code-assets.oss-cn-hangzhou.aliyuncs.com/install.sh | bash',
        manager: npm('@qwen-code/qwen-code'),
      }),
    ).toBe('npm install -g @qwen-code/qwen-code@latest');
    expect(
      updateCommandFor({
        catalogCommand: 'irm https://claude.ai/install.ps1 | iex',
        manager: npm('@anthropic-ai/claude-code'),
      }),
    ).toBe('npm install -g @anthropic-ai/claude-code@latest');
    expect(updateCommandFor({ catalogCommand: null, manager: npm('cline') })).toBe(
      'npm install -g cline@latest',
    );
  });

  it('leaves a self-updater alone, since it already handles npm copies', () => {
    // Pi's own updater keeps its --ignore-scripts install, and codegraph's runs a second step.
    expect(
      updateCommandFor({
        catalogCommand: 'pi update --self',
        manager: npm('@earendil-works/pi-coding-agent'),
      }),
    ).toBe('pi update --self');
    expect(
      updateCommandFor({
        catalogCommand: 'codegraph upgrade; codegraph install',
        manager: npm('codegraph'),
      }),
    ).toBe('codegraph upgrade; codegraph install');
  });

  it('leaves a catalog command that is already npm alone', () => {
    expect(
      updateCommandFor({
        catalogCommand: 'npm install -g @earendil-works/pi-coding-agent@latest --ignore-scripts',
        manager: npm('@earendil-works/pi-coding-agent'),
      }),
    ).toBe('npm install -g @earendil-works/pi-coding-agent@latest --ignore-scripts');
  });

  it('swaps an installer re-run for pip when pip owns the copy and the PyPI name is known', () => {
    expect(
      updateCommandFor({
        catalogCommand: 'curl -LsSf https://aider.chat/install.sh | sh',
        manager: { kind: 'pip' },
        pypiPackage: 'aider-chat',
      }),
    ).toBe('python -m pip install --upgrade aider-chat');
    expect(
      updateCommandFor({
        catalogCommand: 'python -m pip install --upgrade aider-chat',
        manager: { kind: 'pip' },
        pypiPackage: 'aider-chat',
      }),
    ).toBe('python -m pip install --upgrade aider-chat');
    // A pip copy of Semgrep, from before the catalog moved to pipx: pipx would not find it.
    expect(
      updateCommandFor({
        catalogCommand: 'pipx upgrade semgrep',
        manager: { kind: 'pip' },
        pypiPackage: 'semgrep',
      }),
    ).toBe('python -m pip install --upgrade semgrep');
    // Without the PyPI name there is nothing better to offer.
    expect(
      updateCommandFor({
        catalogCommand: 'curl -LsSf https://x.sh | sh',
        manager: { kind: 'pip' },
      }),
    ).toBe('curl -LsSf https://x.sh | sh');
  });
});

describe('reinstallCommandFor', () => {
  it('reinstalls an npm copy with npm, since its own updater is what fails to start', () => {
    // The copy that broke on a real machine: `claude.ps1` from npm, whose claude.exe Windows
    // refused as "not a valid application for this OS platform". `claude update` cannot run, and
    // the vendor installer would add a second copy behind it on PATH.
    expect(
      reinstallCommandFor({
        catalogCommand: 'irm https://claude.ai/install.ps1 | iex',
        manager: { kind: 'npm', pkg: '@anthropic-ai/claude-code' },
      }),
    ).toBe('npm install -g @anthropic-ai/claude-code@latest');
  });

  it('goes through Homebrew or pip for the copies they own', () => {
    expect(
      reinstallCommandFor({
        catalogCommand: 'curl -fsSL https://claude.ai/install.sh | bash',
        manager: { kind: 'brew', name: 'claude-code' },
      }),
    ).toBe('brew reinstall claude-code');
    expect(
      reinstallCommandFor({
        catalogCommand: 'pipx install semgrep',
        manager: { kind: 'pip' },
        pypiPackage: 'semgrep',
      }),
    ).toBe('python -m pip install --force-reinstall semgrep');
  });

  it('runs the catalog install again for a copy no package manager owns', () => {
    expect(
      reinstallCommandFor({
        catalogCommand: 'irm https://claude.ai/install.ps1 | iex',
        manager: null,
      }),
    ).toBe('irm https://claude.ai/install.ps1 | iex');
    expect(
      reinstallCommandFor({ catalogCommand: 'pip install aider-chat', manager: { kind: 'pip' } }),
    ).toBe('pip install aider-chat');
  });
});

describe('uninstallCommandFor', () => {
  it('goes through Homebrew for a Homebrew copy', () => {
    expect(
      uninstallCommandFor({
        catalogCommand: 'rm -f ~/.local/bin/claude',
        manager: { kind: 'brew', name: 'claude-code' },
      }),
    ).toBe('brew uninstall claude-code');
  });

  it('swaps a by-hand removal for npm when npm owns the copy', () => {
    expect(
      uninstallCommandFor({
        catalogCommand: 'rm -rf ~/.grok',
        manager: { kind: 'npm', pkg: '@xai-official/grok' },
      }),
    ).toBe('npm uninstall -g @xai-official/grok');
    expect(
      uninstallCommandFor({
        catalogCommand: 'Remove-Item -Recurse -Force "$env:USERPROFILE\\.grok"',
        manager: { kind: 'npm', pkg: '@xai-official/grok' },
      }),
    ).toBe('npm uninstall -g @xai-official/grok');
  });

  it('swaps a different package manager for the one that owns the copy', () => {
    // Semgrep on a machine that installed it with pip before the catalog moved to pipx.
    expect(
      uninstallCommandFor({
        catalogCommand: 'pipx uninstall semgrep',
        manager: { kind: 'pip' },
        pypiPackage: 'semgrep',
      }),
    ).toBe('python -m pip uninstall -y semgrep');
    expect(
      uninstallCommandFor({
        catalogCommand: 'pipx uninstall semgrep',
        manager: { kind: 'npm', pkg: 'semgrep' },
      }),
    ).toBe('npm uninstall -g semgrep');
  });

  it("keeps the catalog's command otherwise", () => {
    expect(
      uninstallCommandFor({
        catalogCommand: 'codegraph uninstall',
        manager: { kind: 'npm', pkg: '@colbymchenry/codegraph' },
      }),
    ).toBe('codegraph uninstall');
    expect(uninstallCommandFor({ catalogCommand: 'rm -rf ~/.strix', manager: null })).toBe(
      'rm -rf ~/.strix',
    );
    expect(
      uninstallCommandFor({
        catalogCommand: 'pip uninstall -y aider-chat',
        manager: { kind: 'pip' },
      }),
    ).toBe('pip uninstall -y aider-chat');
  });
});
