import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type {
  AgentToolDefinition,
  InstalledAgentTool,
  SupportedOS,
  ToolUpdateCheckResult,
} from '@runova/core';
import {
  AGENT_TOOL_REGISTRY,
  getAgentToolDefinition,
  getDockerRemoveCommand,
  getDockerResetCommand,
  getDockerRunCommand,
  getDockerStartCommand,
  getDockerStopCommand,
  getInteractiveLaunchCommandForCurrentOS,
  getToolInstallCommandForCurrentOS,
  getToolUninstallCommandForCurrentOS,
  getToolUpdateCommandForCurrentOS,
  LEGACY_DOCKER_PREFIX,
} from '@runova/core';
import { ipcMain } from 'electron';
import { IPC } from '../../shared/ipcChannels';
import {
  type InstallManager,
  installManagerOf,
  resolveExecutable,
  uninstallCommandFor,
  updateCommandFor,
} from '../installMethod';
import { compareVersions, fetchLatestVersion } from '../registryVersions';
import { refreshExtraToolPathDirs, withToolPath } from '../toolPaths';
import { refreshWindowsPath } from '../windowsPath';

const execFileAsync = promisify(execFile);
const DETECT_TIMEOUT_MS = 8000;

async function runProbe(command: string, args: string[]): Promise<string | null> {
  try {
    // Detection has to look in the same places a run will, or a tool that pip put in a Scripts
    // folder off PATH reads as "not installed" no matter how many times the user installs it.
    const env = await withToolPath();
    // See cliDetection.ts: npm-installed CLIs are .cmd shims on Windows, which Node
    // refuses to spawn directly, so route through cmd.exe with a static argv array.
    const { stdout } =
      process.platform === 'win32'
        ? await execFileAsync('cmd.exe', ['/d', '/s', '/c', command, ...args], {
            timeout: DETECT_TIMEOUT_MS,
            windowsHide: true,
            env,
          })
        : await execFileAsync(command, args, {
            timeout: DETECT_TIMEOUT_MS,
            windowsHide: true,
            env,
          });
    return stdout.trim();
  } catch {
    return null;
  }
}

const DOCKER_PREFIX = 'runova-';

/** The name a container or volume of this catalog had before the app was renamed. */
function legacyDockerName(name: string): string | null {
  return name.startsWith(DOCKER_PREFIX)
    ? LEGACY_DOCKER_PREFIX + name.slice(DOCKER_PREFIX.length)
    : null;
}

async function dockerObjectExists(kind: 'container' | 'volume', name: string): Promise<boolean> {
  try {
    await execFileAsync('docker', [kind, 'inspect', name], {
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * A container made before the rename still has the old name. It is renamed the first time it is
 * looked for, so start, stop and reset keep working on it. Returns whether one was renamed.
 */
async function renameLegacyContainer(name: string): Promise<boolean> {
  const legacy = legacyDockerName(name);
  if (!legacy || !(await dockerObjectExists('container', legacy))) return false;
  try {
    await execFileAsync('docker', ['rename', legacy, name], {
      timeout: DETECT_TIMEOUT_MS,
      windowsHide: true,
    });
    return true;
  } catch {
    return false;
  }
}

/**
 * Volumes can't be renamed, and they hold the tool's data (SonarQube's projects and settings).
 * When a volume from before the rename is there and the new one isn't, the run command keeps
 * using the old one.
 */
async function withLegacyVolumes(tool: AgentToolDefinition): Promise<AgentToolDefinition> {
  if (!tool.docker) return tool;
  const runArgs = await Promise.all(
    tool.docker.runArgs.map(async (arg) => {
      const [volume, ...rest] = arg.split(':');
      const legacy = rest.length > 0 ? legacyDockerName(volume) : null;
      if (!legacy) return arg;
      if (await dockerObjectExists('volume', volume)) return arg;
      if (!(await dockerObjectExists('volume', legacy))) return arg;
      return [legacy, ...rest].join(':');
    }),
  );
  return { ...tool, docker: { ...tool.docker, runArgs } };
}

async function detectDockerStatus(
  tool: AgentToolDefinition,
  renamed = false,
): Promise<InstalledAgentTool['dockerStatus']> {
  if (!tool.docker) return 'unavailable';
  try {
    const { stdout } = await execFileAsync(
      'docker',
      ['inspect', '-f', '{{.State.Running}}', tool.docker.containerName],
      { timeout: DETECT_TIMEOUT_MS, windowsHide: true },
    );
    return stdout.trim() === 'true' ? 'running' : 'stopped';
  } catch (err) {
    // ENOENT means the `docker` binary itself isn't on PATH, distinct from "docker is
    // installed but this tool's container hasn't been created yet" (any other failure,
    // e.g. `docker inspect`'s "no such container").
    if (err && typeof err === 'object' && 'code' in err && err.code === 'ENOENT')
      return 'unavailable';
    if (!renamed && (await renameLegacyContainer(tool.docker.containerName))) {
      return detectDockerStatus(tool, true);
    }
    return 'not-created';
  }
}

async function detectTool(tool: AgentToolDefinition): Promise<InstalledAgentTool> {
  const [versionOutput, dockerStatus, executablePath] = await Promise.all([
    tool.detectCommand
      ? runProbe(tool.detectCommand.command, tool.detectCommand.args)
      : Promise.resolve(null),
    detectDockerStatus(tool),
    tool.detectCommand ? resolveExecutable([tool.detectCommand.command]) : Promise.resolve(null),
  ]);
  const versionMatch = versionOutput?.match(/\d+\.\d+\.\d+[\w.-]*/);
  return {
    id: tool.id,
    installed: versionOutput !== null,
    version: versionMatch ? versionMatch[0] : (versionOutput?.slice(0, 40) ?? null),
    dockerStatus,
    executablePath,
    lastCheckedAt: new Date().toISOString(),
  };
}

/**
 * What the last detect pass found, so the update and uninstall buttons know whose copy they are
 * dealing with without probing every tool again.
 */
const lastDetected = new Map<string, InstalledAgentTool>();

export async function detectAllTools(): Promise<InstalledAgentTool[]> {
  // Picks up a PATH entry an installer added to the registry since the app started.
  await refreshWindowsPath();
  // A detect pass is also what the user presses after installing something, so this is the
  // right moment to look for script directories that did not exist a minute ago.
  refreshExtraToolPathDirs();
  const results = await Promise.all(AGENT_TOOL_REGISTRY.map((tool) => detectTool(tool)));
  for (const result of results) lastDetected.set(result.id, result);
  return results;
}

/** Who owns the installed copy of `tool`: npm, Homebrew, pip, or nobody we know of. */
async function managerOf(tool: AgentToolDefinition): Promise<InstallManager> {
  const known = lastDetected.get(tool.id);
  const executablePath = known
    ? (known.executablePath ?? null)
    : tool.detectCommand
      ? await resolveExecutable([tool.detectCommand.command])
      : null;
  return executablePath ? installManagerOf(executablePath) : null;
}

export function registerToolHandlers(): void {
  ipcMain.handle(IPC.tools.detectAll, (): Promise<InstalledAgentTool[]> => detectAllTools());

  ipcMain.handle(IPC.tools.getInstallCommand, (_event, toolId: string): string | null => {
    const tool = getAgentToolDefinition(toolId);
    if (!tool) return null;
    return getToolInstallCommandForCurrentOS(tool, process.platform as SupportedOS);
  });

  ipcMain.handle(
    IPC.tools.checkForUpdate,
    async (
      _event,
      toolId: string,
      currentVersion: string | null,
    ): Promise<ToolUpdateCheckResult> => {
      const tool = getAgentToolDefinition(toolId);
      const checkedAt = new Date().toISOString();
      if (!tool?.updateCheck) {
        return {
          toolId,
          supported: false,
          currentVersion,
          latestVersion: null,
          updateAvailable: false,
          checkedAt,
        };
      }
      const latestVersion = await fetchLatestVersion(tool.updateCheck);
      const updateAvailable =
        !!latestVersion && !!currentVersion && compareVersions(latestVersion, currentVersion) > 0;
      return { toolId, supported: true, currentVersion, latestVersion, updateAvailable, checkedAt };
    },
  );

  ipcMain.handle(
    IPC.tools.getUpdateCommand,
    async (_event, toolId: string): Promise<string | null> => {
      const tool = getAgentToolDefinition(toolId);
      if (!tool) return null;
      return updateCommandFor({
        catalogCommand: getToolUpdateCommandForCurrentOS(tool, process.platform as SupportedOS),
        manager: await managerOf(tool),
        pypiPackage: tool.updateCheck?.type === 'pypi' ? tool.updateCheck.package : undefined,
      });
    },
  );

  ipcMain.handle(
    IPC.tools.getUninstallCommand,
    async (_event, toolId: string): Promise<string | null> => {
      const tool = getAgentToolDefinition(toolId);
      if (!tool) return null;
      return uninstallCommandFor({
        catalogCommand: getToolUninstallCommandForCurrentOS(tool, process.platform as SupportedOS),
        manager: await managerOf(tool),
        pypiPackage: tool.updateCheck?.type === 'pypi' ? tool.updateCheck.package : undefined,
      });
    },
  );

  ipcMain.handle(IPC.tools.getInteractiveLaunchCommand, (_event, toolId: string): string | null => {
    const tool = getAgentToolDefinition(toolId);
    if (!tool) return null;
    return getInteractiveLaunchCommandForCurrentOS(tool, process.platform as SupportedOS);
  });

  ipcMain.handle(
    IPC.tools.getDockerCommand,
    async (
      _event,
      toolId: string,
      action: 'run' | 'start' | 'stop' | 'reset' | 'remove',
    ): Promise<string | null> => {
      const tool = getAgentToolDefinition(toolId);
      if (!tool) return null;
      if (action === 'run') return getDockerRunCommand(await withLegacyVolumes(tool));
      if (action === 'start') return getDockerStartCommand(tool);
      if (action === 'stop') return getDockerStopCommand(tool);
      if (action === 'remove') return getDockerRemoveCommand(tool);
      return getDockerResetCommand(await withLegacyVolumes(tool), process.platform as SupportedOS);
    },
  );
}
