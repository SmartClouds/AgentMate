import { randomUUID } from 'node:crypto';
import {
  buildAgentLaunchCommand,
  type CliLaunchDefault,
  cliLaunchOptions,
  getCliDefinition,
  type ShellKind,
  shellKindFor,
} from '@runova/core';
import { clipboard } from 'electron';
import type { AutoFixTabEvent } from '../../../shared/ciAutoFixTypes';
import { claudeHookSettingsPath, supportsStatusHooks } from '../../agents/claudeHooks';
import { agentStatus } from '../../agents/statusTracker';
import {
  createTerminalSession,
  defaultTerminalShell,
  subscribeTerminalOutput,
  writeToShell,
} from '../../ipc/terminal';
import { showOsNotification } from '../../notifications/osNotification';
import { deliverWhenReady } from '../../relay/delivery';
import { store } from '../../store';

/**
 * The launch modes that let an agent edit and run checks without asking, best first. The ones that
 * also drop the sandbox (bypassPermissions, yolo, full-access) are left out on purpose.
 */
const UNATTENDED_MODES = ['auto', 'autopilot', 'auto_edit', 'acceptEdits'];

/** The flags that start this CLI in its unattended mode, or none when it has no such mode. */
export function autoFixModeArgs(cliId: string): string[] {
  const modes = cliLaunchOptions(cliId)?.modes ?? [];
  for (const id of UNATTENDED_MODES) {
    const mode = modes.find((item) => item.id === id);
    if (mode) return [...mode.args];
  }
  return [];
}

/**
 * The line an auto-fix tab types. The prompt is not on it: it holds the whole failure log, which is
 * long and spans lines, so it is pasted once the CLI is up instead. A saved model still applies,
 * but the unattended mode replaces any saved mode, since a saved plan mode would stall the fix.
 */
export function buildAutoFixCommand(input: {
  cliId: string;
  shellKind: ShellKind;
  hookSettingsPath: string | null;
  runArgs: string[];
  launchDefaults?: CliLaunchDefault;
}): string | null {
  return buildAgentLaunchCommand({
    cliId: input.cliId,
    shellKind: input.shellKind,
    hookSettingsPath: input.hookSettingsPath,
    launchDefaults: input.launchDefaults,
    runArgs: [...autoFixModeArgs(input.cliId), ...input.runArgs],
  });
}

export interface AutoFixLaunchRequest {
  sessionId: string;
  projectId: string;
  cwd: string;
  cliId: string;
  runArgs: string[];
  runLabel: string | null;
  runNumber: number | null;
  attempt: number;
  prompt: string;
}

export interface AutoFixLaunchResult {
  tabId: string;
  /** The CLI reports through status hooks, so its `done` is exact. */
  hooks: boolean;
  tab: AutoFixTabEvent;
}

/**
 * Starts one attempt's agent: a terminal session main owns (the renderer shows it as a workspace
 * tab later), running the CLI in the project, with the prompt pasted and submitted once it is up.
 */
export async function launchAutoFixAgent(
  request: AutoFixLaunchRequest,
): Promise<AutoFixLaunchResult> {
  const cli = getCliDefinition(request.cliId);
  if (!cli) throw new Error(`Runova does not know the CLI "${request.cliId}".`);
  const shell = defaultTerminalShell();
  const hooks = supportsStatusHooks(request.cliId);
  const [hookSettingsPath, settings] = await Promise.all([
    hooks ? claudeHookSettingsPath() : Promise.resolve(null),
    store.getSettings(),
  ]);
  const command = buildAutoFixCommand({
    cliId: request.cliId,
    shellKind: shellKindFor(shell, process.platform),
    hookSettingsPath,
    runArgs: request.runArgs,
    launchDefaults: settings.cliLaunchDefaults?.[request.cliId],
  });
  if (!command) throw new Error(`${cli.name} has no launch command.`);

  const tabId = randomUUID();
  const title = `Auto-fix${request.runNumber ? ` #${request.runNumber}` : ''} · ${cli.name}`;
  agentStatus.pin({ sessionId: tabId, projectId: request.projectId, cliId: request.cliId, title });
  const created = await createTerminalSession(
    {
      sessionId: tabId,
      shell,
      cwd: request.cwd,
      initialInput: `${command}\r`,
      projectId: request.projectId,
      cliId: request.cliId,
      surface: 'workspace',
    },
    null,
  ).catch((error: unknown) => {
    agentStatus.unpin(tabId);
    throw error;
  });
  if (!created) {
    agentStatus.unpin(tabId);
    throw new Error('The terminal could not start.');
  }

  void deliverWhenReady(request.prompt, {
    subscribe: (listener) => subscribeTerminalOutput(tabId, listener),
    write: (data) => writeToShell(tabId, data),
  }).then((delivered) => {
    if (delivered) return;
    clipboard.writeText(request.prompt);
    showOsNotification({
      title: `${cli.name} did not come up for auto-fix`,
      body: 'The prompt is on your clipboard. Paste it in the tab once the CLI is running.',
      route: `/workspace/${request.projectId}?session=${encodeURIComponent(tabId)}`,
    });
  });

  return {
    tabId,
    // Without the settings file the hooks never fire, and the tab falls back to its output.
    hooks: hooks && hookSettingsPath !== null,
    tab: {
      projectId: request.projectId,
      tabId,
      sessionId: request.sessionId,
      cliId: request.cliId,
      title,
      runLabel: [`Attempt ${request.attempt}`, request.runLabel].filter(Boolean).join(' · '),
      cwd: request.cwd,
    },
  };
}
