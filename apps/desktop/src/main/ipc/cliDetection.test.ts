import { chmodSync, mkdirSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import type { CliUpdateCheckResult, InstalledCli } from '@runova/core';
import { CLI_REGISTRY, getUpdateCommandForCurrentOS, type SupportedOS } from '@runova/core';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { tempDir, writeTree } from '../../test/main/fixtures';
import {
  expectChannelsCovered,
  invoke,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Whether each AI CLI is installed, which the Dashboard, CLI Manager, Tools and Project Detail all
 * ask for. A full sweep spawns a child process per registry entry, so the answer is cached and
 * concurrent callers share one sweep: that bookkeeping is the part worth pinning, along with a
 * missing CLI being remembered only briefly so one installed since shows up.
 *
 * The probe looks for real executables on PATH, so a fake one is put on a temp PATH rather than
 * mocking the child process layer. Reading the login shell's PATH is stood in for, since the real
 * one would put whatever this machine has installed back on PATH.
 */

useTempUserData();
expectChannelsCovered(IPC.cli);

const fetchMock = vi.fn();
let binDir = '';
/** A folder only the user's login shell has on PATH, like ~/.local/bin for a Mac app from Finder. */
let loginShellDir: string | null = null;
const { refreshShellPath } = vi.hoisted(() => ({
  refreshShellPath: vi.fn<(options?: { force?: boolean }) => Promise<void>>(),
}));
vi.mock('../shellPath', () => ({ refreshShellPath }));
/**
 * The folders native installers use (~/.local/bin and friends). The real list would point at this
 * machine's home folder and start Python to find its Scripts folder.
 */
const toolDirs = vi.hoisted(() => ({ current: [] as string[] }));
const { refreshExtraToolPathDirs } = vi.hoisted(() => ({ refreshExtraToolPathDirs: vi.fn() }));
vi.mock('../toolPaths', () => ({
  getExtraToolPathDirs: async () => toolDirs.current,
  pythonScriptDirs: async () => [],
  refreshExtraToolPathDirs,
  withToolPath: async (env?: NodeJS.ProcessEnv) => {
    const base = { ...(env ?? process.env) };
    const key = Object.keys(base).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
    base[key] = [base[key], ...toolDirs.current].filter(Boolean).join(delimiter);
    return base;
  },
}));
// Reading PATH back from the registry would put this machine's real Node.js on it.
vi.mock('../windowsPath', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../windowsPath')>()),
  refreshWindowsPath: async () => undefined,
}));

async function register(): Promise<void> {
  await loadIpc(
    () => import('./cliDetection'),
    (module) => module.registerCliDetectionHandlers(),
  );
}

/** A `claude` on PATH that answers --version, the way CLI detection expects. */
function writeFakeClaude(version = '9.9.9', dir = binDir): void {
  if (process.platform === 'win32') {
    writeFileSync(
      join(dir, 'claude.cmd'),
      ['@echo off', `echo ${version} (Claude Code)`, ''].join('\r\n'),
    );
    return;
  }
  const script = join(dir, 'claude');
  writeFileSync(script, ['#!/bin/sh', `echo "${version} (Claude Code)"`, ''].join('\n'));
  chmodSync(script, 0o755);
}

/** On Windows the probe goes through cmd.exe, so System32 joins the fake PATH for it to start. */
function letCmdStart(): void {
  if (process.platform !== 'win32') return;
  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  const system32 = join(process.env.SystemRoot ?? 'C:\\Windows', 'System32');
  vi.stubEnv(key, [binDir, system32].join(delimiter));
}

/** A `claude` on PATH whose version command exits non-zero, printing `message` to stderr. */
function writeFailingClaude(message: string, alsoPrint = ''): void {
  letCmdStart();
  if (process.platform === 'win32') {
    writeFileSync(
      join(binDir, 'claude.cmd'),
      [
        '@echo off',
        ...(alsoPrint ? [`echo ${alsoPrint}`] : []),
        `echo ${message} 1>&2`,
        'exit /b 1',
        '',
      ].join('\r\n'),
    );
    return;
  }
  const script = join(binDir, 'claude');
  writeFileSync(
    script,
    [
      '#!/bin/sh',
      ...(alsoPrint ? [`echo "${alsoPrint}"`] : []),
      `echo "${message}" >&2`,
      'exit 1',
      '',
    ].join('\n'),
  );
  chmodSync(script, 0o755);
}

function claude(list: InstalledCli[]): InstalledCli | undefined {
  return list.find((one) => one.id === 'claude-code');
}

beforeEach(async () => {
  binDir = join(tempDir('runova-clis-'), 'bin');
  mkdirSync(binDir, { recursive: true });
  const key = Object.keys(process.env).find((one) => one.toUpperCase() === 'PATH') ?? 'PATH';
  // Only the fake binaries are on PATH, so a CLI really installed on this machine cannot make
  // the result depend on who is running the tests.
  vi.stubEnv(key, binDir);
  loginShellDir = null;
  toolDirs.current = [];
  refreshExtraToolPathDirs.mockReset();
  refreshShellPath.mockReset();
  refreshShellPath.mockImplementation(async () => {
    if (!loginShellDir) return;
    process.env[key] = [process.env[key], loginShellDir].filter(Boolean).join(delimiter);
  });
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
  await register();
});

afterEach(() => {
  vi.unstubAllEnvs();
});

describe('detecting installed CLIs', () => {
  it('reports every CLI in the registry, installed or not', async () => {
    const list = await invoke<InstalledCli[]>(IPC.cli.detectAll, true);

    expect(list.length).toBeGreaterThan(5);
    expect(claude(list)).toBeDefined();
  });

  it('finds a CLI that is on PATH and names the file it found', async () => {
    writeFakeClaude();

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    // Finding the executable is what decides "installed", rather than a version answering in
    // time, so that is asserted on both platforms.
    expect(found?.installed).toBe(true);
    expect(found?.executablePath?.toLowerCase()).toContain('claude');
  });

  it.skipIf(process.platform === 'win32')('reads the version the CLI prints', async () => {
    // Skipped on Windows: the probe runs the executable directly, and a .cmd shim needs a shell,
    // so the version comes back null there even though the CLI is found.
    writeFakeClaude();

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(found?.version).toContain('9.9.9');
  });

  it('finds a CLI only the login shell has on PATH, the way a Mac app opened from Finder starts', async () => {
    // launchd gives a Finder-launched app /usr/bin:/bin:/usr/sbin:/sbin, and Claude Code's
    // installer puts it in ~/.local/bin through .zshrc. Searching the app's own PATH alone showed
    // it as not installed in the CLI Manager and the workspace while every terminal ran it.
    loginShellDir = join(tempDir('runova-login-shell-'), '.local', 'bin');
    mkdirSync(loginShellDir, { recursive: true });
    writeFakeClaude('9.9.9', loginShellDir);

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(refreshShellPath).toHaveBeenCalledWith({ force: true });
    expect(found?.installed).toBe(true);
    expect(found?.executablePath?.toLowerCase()).toContain(loginShellDir.toLowerCase());
  });

  it('finds a CLI only a native installer folder has, and looks for new folders on a forced sweep', async () => {
    // Claude's native installer drops it in ~/.local/bin and adds that to PATH only through a
    // shell rc file, which the app never reads.
    const localBin = join(tempDir('runova-native-'), '.local', 'bin');
    mkdirSync(localBin, { recursive: true });
    writeFakeClaude('9.9.9', localBin);
    toolDirs.current = [localBin];

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(refreshExtraToolPathDirs).toHaveBeenCalled();
    expect(found?.installed).toBe(true);
    expect(found?.executablePath?.toLowerCase()).toContain(localBin.toLowerCase());
  });

  it.skipIf(process.platform === 'win32')(
    'reads the version of a CLI found only in a native installer folder',
    async () => {
      const localBin = join(tempDir('runova-native-'), '.local', 'bin');
      mkdirSync(localBin, { recursive: true });
      writeFakeClaude('9.9.9', localBin);
      toolDirs.current = [localBin];

      const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

      expect(found?.version).toContain('9.9.9');
    },
  );

  it('flags a CLI that is found but fails to start, and says what it printed', async () => {
    // What an npm copy with a broken claude.exe looked like: on PATH, so "installed", while
    // every terminal got "not a valid application for this OS platform".
    writeFailingClaude('The system cannot execute the specified program.');

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(found?.installed).toBe(true);
    expect(found?.version).toBeNull();
    expect(found?.runError).toBe('The system cannot execute the specified program.');
  });

  it('does not flag a CLI that prints its version and still exits non-zero', async () => {
    writeFailingClaude('some warning', '9.9.9 (Claude Code)');

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(found?.installed).toBe(true);
    expect(found?.runError).toBeUndefined();
  });

  it('does not flag a CLI that answers normally', async () => {
    letCmdStart();
    writeFakeClaude();

    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(found?.version).toContain('9.9.9');
    expect(found?.runError).toBeUndefined();
  });

  it.runIf(process.platform === 'win32')(
    'does not blame the CLI when cmd.exe itself cannot start',
    async () => {
      // PATH here holds only the fake folder, so cmd.exe is nowhere to be found.
      writeFakeClaude();

      const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

      expect(found?.installed).toBe(true);
      expect(found?.runError).toBeUndefined();
    },
  );

  it('reports one that is nowhere on PATH as missing', async () => {
    const found = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(found?.installed).toBe(false);
    expect(found?.executablePath).toBeFalsy();
  });

  it('serves a second caller from the cache instead of sweeping again', async () => {
    writeFakeClaude();
    const first = await invoke<InstalledCli[]>(IPC.cli.detectAll);

    // A sweep spawns a process per registry entry, which is why navigation between pages must
    // not start a new one each time.
    const second = await invoke<InstalledCli[]>(IPC.cli.detectAll);

    expect(second).toBe(first);
  });

  it('sweeps again when the caller forces a refresh', async () => {
    const before = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll));
    expect(before?.installed).toBe(false);

    // What the Refresh button in the CLI Manager does, after the user installed something.
    writeFakeClaude();
    const after = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll, true));

    expect(after?.installed).toBe(true);
  });

  it('notices a CLI installed a moment ago, because a missing result is kept only briefly', async () => {
    // Only the clock is faked: the sweep itself spawns processes and reads files, which need
    // real timers to finish.
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      await invoke<InstalledCli[]>(IPC.cli.detectAll);
      writeFakeClaude();

      // Past the short window a sweep with something missing is cached for, but well inside the
      // long one a complete sweep would get.
      vi.setSystemTime(Date.now() + 25_000);

      const after = claude(await invoke<InstalledCli[]>(IPC.cli.detectAll));
      expect(after?.installed).toBe(true);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('install and update commands', () => {
  it('gives the install command for this OS', async () => {
    const command = await invoke<string | null>(IPC.cli.getInstallCommand, 'claude-code');

    expect(command).toBeTruthy();
  });

  it('answers null for a CLI it has never heard of', async () => {
    await expect(invoke(IPC.cli.getInstallCommand, 'not-a-cli')).resolves.toBeNull();
    await expect(invoke(IPC.cli.getUpdateCommand, 'not-a-cli')).resolves.toBeNull();
  });

  it('gives the update command for this OS', async () => {
    await expect(invoke(IPC.cli.getUpdateCommand, 'claude-code')).resolves.toBeTruthy();
  });

  it("updates an npm-installed copy with npm when the catalog's update is the vendor installer", async () => {
    // Re-running Qwen's install script over an old `npm install -g` copy would leave the npm
    // one in place and still first on PATH, so the update would seem to do nothing.
    const platform = process.platform as SupportedOS;
    const cli = CLI_REGISTRY.find((one) => {
      const command = getUpdateCommandForCurrentOS(one, platform);
      return (
        one.updateCheck?.type === 'npm' &&
        one.supportedOS.includes(platform) &&
        !!command &&
        /^(curl|irm|iwr|wget)\b/i.test(command)
      );
    });
    if (!cli || cli.updateCheck?.type !== 'npm') throw new Error('no CLI updates by script here');
    const pkg = cli.updateCheck.package;
    const name = cli.versionCommand.command;
    // The layout `npm install -g` leaves on Windows: a shim next to node_modules, naming the
    // package it runs. On macOS and Linux the extensionless shim reads the same way.
    writeTree(binDir, {
      [`node_modules/${pkg}/cli.js`]: '',
      [process.platform === 'win32' ? `${name}.cmd` : name]:
        process.platform === 'win32'
          ? `@echo off\r\n"%dp0%\\node_modules\\${pkg.replace('/', '\\')}\\cli.js" %*\r\n`
          : `#!/bin/sh\n# "$basedir/node_modules/${pkg}/cli.js"\necho 1.0.0\n`,
    });
    if (process.platform !== 'win32') chmodSync(join(binDir, name), 0o755);
    await invoke(IPC.cli.detectAll, true);

    await expect(invoke(IPC.cli.getUpdateCommand, cli.id)).resolves.toBe(
      `npm install -g ${pkg}@latest`,
    );
  });

  it('reinstalls a broken npm copy with npm rather than the vendor installer', async () => {
    const pkg = '@anthropic-ai/claude-code';
    writeTree(binDir, {
      [`node_modules/${pkg}/bin/claude.exe`]: '',
      [process.platform === 'win32' ? 'claude.cmd' : 'claude']:
        process.platform === 'win32'
          ? '@echo off\r\n"%dp0%\\node_modules\\@anthropic-ai\\claude-code\\bin\\claude.exe" %*\r\nexit /b 1\r\n'
          : `#!/bin/sh\n# "$basedir/node_modules/${pkg}/bin/claude.exe"\nexit 1\n`,
    });
    if (process.platform !== 'win32') chmodSync(join(binDir, 'claude'), 0o755);
    await invoke(IPC.cli.detectAll, true);

    await expect(invoke(IPC.cli.getReinstallCommand, 'claude-code')).resolves.toBe(
      `npm install -g ${pkg}@latest`,
    );
  });

  it('reinstalls a copy no package manager owns with the install command', async () => {
    writeFailingClaude('cannot execute binary file');
    await invoke(IPC.cli.detectAll, true);

    await expect(invoke(IPC.cli.getReinstallCommand, 'claude-code')).resolves.toBe(
      await invoke(IPC.cli.getInstallCommand, 'claude-code'),
    );
    await expect(invoke(IPC.cli.getReinstallCommand, 'not-a-cli')).resolves.toBeNull();
  });

  it("keeps the catalog's update for a copy no package manager owns", async () => {
    writeFakeClaude();
    await invoke(IPC.cli.detectAll, true);

    const definition = CLI_REGISTRY.find((one) => one.id === 'claude-code');
    if (!definition) throw new Error('claude-code is missing from the registry');
    const catalog = getUpdateCommandForCurrentOS(definition, process.platform as SupportedOS);
    await expect(invoke(IPC.cli.getUpdateCommand, 'claude-code')).resolves.toBe(catalog);
  });
});

describe('checking what an install command needs', () => {
  it('names Node.js when an npm command has no npm to run it', async () => {
    await expect(
      invoke(IPC.cli.checkCommandPrerequisite, 'npm install -g @openai/codex'),
    ).resolves.toEqual({ name: 'Node.js', url: 'https://nodejs.org/en/download' });
  });

  it('answers null once npm is on PATH', async () => {
    writeTree(binDir, {
      [process.platform === 'win32' ? 'npm.cmd' : 'npm']:
        process.platform === 'win32' ? '@echo off\r\n' : '#!/bin/sh\n',
    });
    if (process.platform !== 'win32') chmodSync(join(binDir, 'npm'), 0o755);

    await expect(
      invoke(IPC.cli.checkCommandPrerequisite, 'npm install -g @openai/codex'),
    ).resolves.toBeNull();
  });

  it('asks nothing of a vendor install script', async () => {
    await expect(
      invoke(IPC.cli.checkCommandPrerequisite, 'curl -fsSL https://claude.ai/install.sh | bash'),
    ).resolves.toBeNull();
  });
});

describe('checking for a newer version', () => {
  it('says an update is available when the registry has a higher version', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '2.0.0' }),
    } as Response);

    const result = await invoke<CliUpdateCheckResult>(
      IPC.cli.checkForUpdate,
      'claude-code',
      '1.0.0',
    );

    expect(result).toMatchObject({
      supported: true,
      latestVersion: '2.0.0',
      updateAvailable: true,
    });
  });

  it('says no update when the installed version is already the latest', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      status: 200,
      json: async () => ({ version: '1.0.0' }),
    } as Response);

    const result = await invoke<CliUpdateCheckResult>(
      IPC.cli.checkForUpdate,
      'claude-code',
      '1.0.0',
    );

    expect(result.updateAvailable).toBe(false);
  });

  it('reports unsupported rather than failing for a CLI with no update source', async () => {
    const result = await invoke<CliUpdateCheckResult>(IPC.cli.checkForUpdate, 'not-a-cli', '1.0.0');

    expect(result).toMatchObject({ supported: false, latestVersion: null, updateAvailable: false });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('claims no update when the version cannot be read, rather than guessing', async () => {
    fetchMock.mockResolvedValue({ ok: false, status: 503, json: async () => ({}) } as Response);

    const result = await invoke<CliUpdateCheckResult>(
      IPC.cli.checkForUpdate,
      'claude-code',
      '1.0.0',
    );

    expect(result.updateAvailable).toBe(false);
  });
});
