import { type ChildProcess, execFile } from 'node:child_process';
import type {
  CliDefinition,
  CliUpdateCheckResult,
  InstalledCli,
  SupportedOS,
} from '@agentmat/core';
import {
  CLI_REGISTRY,
  getCliDefinition,
  getInstallCommandForCurrentOS,
  getUpdateCommandForCurrentOS,
} from '@agentmat/core';
import { ipcMain } from 'electron';
import type { CommandPrerequisite } from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import { checkCommandPrerequisite } from '../commandPrerequisite';
import {
  grokInstalledWithNpm,
  installManagerOf,
  resolveExecutable,
  updateCommandFor,
} from '../installMethod';
import { mapWithConcurrency } from '../packageManagers/execUtils';
import { compareVersions, fetchLatestVersion } from '../registryVersions';
import { killProcessTree } from '../security/exec';
import { refreshShellPath } from '../shellPath';
import { refreshExtraToolPathDirs, withToolPath } from '../toolPaths';

/**
 * Some CLIs take a long time to answer `--version` (Cline and Cursor's agent run past ten seconds,
 * a cold Node start under antivirus is slow too). Being slow no longer means "not installed", since
 * finding the executable decides that, so this only bounds how long the version is waited for.
 */
const VERSION_TIMEOUT_MS = 20_000;
/** Fifteen Node CLIs starting at once slowed each other past the timeout. */
const PROBE_CONCURRENCY = 4;

interface VersionProbe {
  stdout: string;
  ok: boolean;
}

/**
 * Runs the CLI's version command. `executablePath` is where detection found it; on POSIX that is
 * what gets spawned, so a CLI found only in one of the extra tool folders answers too.
 */
async function probeVersion(
  cli: CliDefinition,
  executablePath: string | null,
): Promise<VersionProbe> {
  // The extra tool folders go on the child's PATH as well, which is what lets cmd.exe find a CLI
  // that a native installer put somewhere the app's own PATH does not reach.
  // Cline's CLI self-updates on every invocation, including a bare version check, by
  // spawning a detached background installer; on Windows that can flash open a visible
  // console. This is a no-op env var for every other CLI we shell out to.
  const env = await withToolPath({ ...process.env, CLINE_NO_AUTO_UPDATE: '1' });
  return new Promise((resolve) => {
    // npm-installed global CLIs are typically .cmd shims on Windows, which
    // Node refuses to spawn directly (security fix in Node >=18.20/20.11/21.6).
    // Route through cmd.exe explicitly (argv array, not `shell: true`) so
    // Node doesn't naively string-concatenate args. command/args here are
    // always static, developer-authored registry entries, never renderer input.
    const options = {
      windowsHide: true,
      maxBuffer: 4 * 1024 * 1024,
      env,
    };
    let settled = false;
    const finish = (probe: VersionProbe): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(probe);
    };
    const callback = (error: Error | null, stdout: string): void => {
      finish({ stdout: stdout ?? '', ok: !error });
    };
    const child: ChildProcess =
      process.platform === 'win32'
        ? execFile(
            'cmd.exe',
            ['/d', '/s', '/c', cli.versionCommand.command, ...cli.versionCommand.args],
            options,
            callback,
          )
        : execFile(
            executablePath ?? cli.versionCommand.command,
            cli.versionCommand.args,
            options,
            callback,
          );
    // Killing only cmd.exe left the CLI itself running and holding the output pipe open.
    const timer = setTimeout(() => {
      killProcessTree(child);
      finish({ stdout: '', ok: false });
    }, VERSION_TIMEOUT_MS);
  });
}

async function detectCli(cli: CliDefinition): Promise<InstalledCli> {
  const lastCheckedAt = new Date().toISOString();
  const executablePath = await resolveExecutable([
    cli.versionCommand.command,
    ...cli.executableNames,
  ]);
  const probe = await probeVersion(cli, executablePath);
  // Found on PATH is installed even when the version check fails or runs long (a CLI in the
  // middle of updating itself, a slow cold start). Otherwise the check answering at all is proof.
  const installed = executablePath !== null || probe.ok;
  const stdout = probe.ok ? probe.stdout : '';
  const versionMatch = stdout.match(/\d+\.\d+\.\d+[\w.-]*/);
  return {
    id: cli.id,
    installed,
    version: installed
      ? versionMatch
        ? versionMatch[0]
        : stdout.trim().slice(0, 40) || null
      : null,
    executablePath,
    lastCheckedAt,
  };
}

/**
 * A full sweep spawns one child process per registry entry (two on Windows, via
 * cmd.exe) and five renderer call sites share the same query key, so plain
 * navigation between Dashboard, CLI Manager, Tools and Project Detail used to
 * re-run the whole thing every few seconds. Installing or removing a CLI is rare
 * enough that a few minutes of staleness costs nothing, and the CLI Manager's
 * Refresh button passes `force` when the user genuinely wants a rescan.
 */
const DETECT_CACHE_TTL_MS = 5 * 60 * 1000;
/** A sweep that found something missing is kept only briefly, so a CLI installed since shows up. */
const MISSING_CACHE_TTL_MS = 20 * 1000;

let detectCache: { value: InstalledCli[]; at: number } | null = null;
let detectInFlight: Promise<InstalledCli[]> | null = null;

export function detectAllClis(force: boolean): Promise<InstalledCli[]> {
  if (!force && detectCache) {
    const ttl = detectCache.value.every((cli) => cli.installed)
      ? DETECT_CACHE_TTL_MS
      : MISSING_CACHE_TTL_MS;
    if (Date.now() - detectCache.at < ttl) return Promise.resolve(detectCache.value);
  }
  // Concurrent callers share one sweep rather than each starting their own. A forced rescan
  // still waits for a running one to end first, then starts over with a fresh PATH.
  if (detectInFlight && !force) return detectInFlight;
  const previous = detectInFlight ?? Promise.resolve([]);
  const sweep = previous
    .catch(() => [])
    .then(async () => {
      // On a Mac opened from Finder this is what puts ~/.local/bin, Homebrew and nvm on PATH.
      await refreshShellPath({ force: true });
      // A forced rescan is what the user asks for right after an install, which may have just
      // created a folder (a Python Scripts dir, ~/.grok/bin) the cached list did not have.
      if (force) refreshExtraToolPathDirs();
      return mapWithConcurrency(CLI_REGISTRY, PROBE_CONCURRENCY, detectCli);
    })
    .then((value) => {
      detectCache = { value, at: Date.now() };
      return value;
    })
    .finally(() => {
      if (detectInFlight === sweep) detectInFlight = null;
    });
  detectInFlight = sweep;
  return sweep;
}

export function registerCliDetectionHandlers(): void {
  ipcMain.handle(IPC.cli.detectAll, (_event, force?: boolean): Promise<InstalledCli[]> => {
    return detectAllClis(force === true);
  });

  ipcMain.handle(IPC.cli.getInstallCommand, (_event, cliId: string): string | null => {
    const cli = getCliDefinition(cliId);
    if (!cli) return null;
    return getInstallCommandForCurrentOS(cli, process.platform as SupportedOS);
  });

  ipcMain.handle(
    IPC.cli.checkForUpdate,
    async (_event, cliId: string, currentVersion: string | null): Promise<CliUpdateCheckResult> => {
      const cli = getCliDefinition(cliId);
      const checkedAt = new Date().toISOString();
      if (!cli?.updateCheck) {
        return {
          cliId,
          supported: false,
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          checkedAt,
        };
      }
      const latestVersion = await fetchLatestVersion(cli.updateCheck);
      const updateAvailable =
        !!latestVersion && !!currentVersion && compareVersions(latestVersion, currentVersion) > 0;
      return { cliId, supported: true, currentVersion, latestVersion, updateAvailable, checkedAt };
    },
  );

  ipcMain.handle(
    IPC.cli.getUpdateCommand,
    async (_event, cliId: string): Promise<string | null> => {
      const cli = getCliDefinition(cliId);
      if (!cli) return null;
      const catalogCommand = getUpdateCommandForCurrentOS(cli, process.platform as SupportedOS);
      if (
        cli.id === 'grok-cli' &&
        process.platform === 'win32' &&
        cli.updateCheck?.type === 'npm' &&
        (await grokInstalledWithNpm())
      ) {
        return `npm install -g ${cli.updateCheck.package}@latest`;
      }
      // The copy being run may be an old npm or Homebrew install rather than the vendor's, and the
      // vendor's installer would put a second copy next to it instead of updating it.
      const detected = (await detectAllClis(false)).find((one) => one.id === cli.id);
      if (!detected?.executablePath) return catalogCommand;
      return updateCommandFor({
        catalogCommand,
        manager: await installManagerOf(detected.executablePath),
        pypiPackage: cli.updateCheck?.type === 'pypi' ? cli.updateCheck.package : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC.cli.checkCommandPrerequisite,
    (_event, command: string): Promise<CommandPrerequisite | null> =>
      typeof command === 'string' ? checkCommandPrerequisite(command) : Promise.resolve(null),
  );
}
