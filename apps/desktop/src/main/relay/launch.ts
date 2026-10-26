import { randomUUID } from 'node:crypto';
import {
  buildAgentLaunchCommand,
  buildLegPrompt,
  type CliLaunchDefault,
  type EffortLevel,
  getCliDefinition,
  launchPickArgs,
  launchPickLabel,
  type RelayAfterPlanMode,
  type RelayRunChoice,
  type RelayState,
  relayPlanArgs,
  type ShellKind,
  shellKindFor,
} from '@runova/core';
import { clipboard } from 'electron';
import type { RelayLegTabEvent } from '../../shared/relayTypes';
import { claudeRelaySettingsPath } from '../agents/claudeHooks';
import { agentStatus } from '../agents/statusTracker';
import {
  createTerminalSession,
  defaultTerminalShell,
  subscribeTerminalOutput,
  writeToShell,
} from '../ipc/terminal';
import { showOsNotification } from '../notifications/osNotification';
import { store } from '../store';
import { findProjectScope } from '../worktrees/resolve';
import { deliverWhenReady } from './delivery';
import { relayMcpLaunchArgs } from './mcp/config';
import {
  ensureGuide,
  ensureHandoffTemplate,
  handoffMtime,
  readBoardFiles,
  relayFolder,
} from './taskFiles';

export interface LegCommandInput {
  cliId: string;
  shellKind: ShellKind;
  choice: RelayRunChoice;
  planFirst: boolean;
  afterPlanMode: RelayAfterPlanMode;
  /** The relay hook settings, for Claude Code. Null when hooks cannot run here. */
  hookSettingsPath: string | null;
  mcpArgs: string[];
  prompt: string;
  /** The user's saved launch defaults for this CLI, from Settings. */
  launchDefaults?: CliLaunchDefault;
}

/**
 * The line a leg's terminal types. Claude Code starts bare (no saved launch defaults, since a saved
 * plan mode would stop an unattended leg), in plan mode or in the after-plan mode, and takes the
 * prompt as its last argument, which T0 proved submits on its own in PowerShell. Every other CLI
 * keeps its saved defaults and gets its prompt pasted once it is ready (promptInCommand false).
 */
export function buildLegCommand(input: LegCommandInput): {
  command: string | null;
  promptInCommand: boolean;
} {
  const pick = launchPickArgs(input.cliId, {
    model: input.choice.model ?? undefined,
    effort: (input.choice.effort ?? undefined) as EffortLevel | undefined,
  });
  const plan = input.planFirst ? (relayPlanArgs(input.cliId) ?? []) : [];
  if (input.cliId === 'claude-code') {
    const mode = ['--permission-mode', input.planFirst ? 'plan' : input.afterPlanMode];
    return {
      command: buildAgentLaunchCommand({
        cliId: input.cliId,
        shellKind: input.shellKind,
        hookSettingsPath: input.hookSettingsPath,
        skipLaunchDefaults: true,
        // --mcp-config and --allowedTools take a list and would swallow the prompt as one more
        // entry, so they come first and a single-value flag always sits right before the prompt.
        runArgs: [...input.mcpArgs, ...mode, ...pick, input.prompt],
      }),
      promptInCommand: true,
    };
  }
  return {
    command: buildAgentLaunchCommand({
      cliId: input.cliId,
      shellKind: input.shellKind,
      launchDefaults: input.launchDefaults,
      runArgs: [...plan, ...pick, ...input.mcpArgs],
    }),
    promptInCommand: false,
  };
}

export interface LegLaunchRequest {
  relay: RelayState;
  legId: string;
  taskId: string;
  legNo: number;
  continuation: boolean;
  planFirst: boolean;
  budget: number;
  choice: RelayRunChoice;
}

export interface LegLaunchResult {
  tabId: string;
  handoffMtimeAtStart: number | null;
  /** The CLI reports through the relay hooks; false falls back to watching its output. */
  hooks: boolean;
  tab: RelayLegTabEvent;
}

/**
 * Starts one leg: the guide and the handoff template in place, a new terminal session (main's own,
 * shown later as a workspace tab) running the CLI, and the prompt in it.
 */
export async function launchRelayLeg(request: LegLaunchRequest): Promise<LegLaunchResult> {
  const { relay, choice, taskId } = request;
  const cli = getCliDefinition(choice.cliId);
  if (!cli) throw new Error(`Runova does not know the CLI "${choice.cliId}".`);
  const project = await findProjectScope(relay.projectId);
  if (!project) throw new Error('That project no longer exists.');

  const folder = relayFolder(project.folderPath, relay.docsFolder);
  const task = (await readBoardFiles(folder)).files.find((file) => file.task.id === taskId);
  if (!task) throw new Error(`The file for ${taskId} is gone.`);
  await ensureGuide(folder);
  await ensureHandoffTemplate(folder, { id: taskId, title: task.task.title });
  const handoffMtimeAtStart = await handoffMtime(folder, taskId);

  const shell = defaultTerminalShell();
  const isClaude = choice.cliId === 'claude-code';
  const [hookSettingsPath, mcpArgs, settings] = await Promise.all([
    isClaude ? claudeRelaySettingsPath() : Promise.resolve(null),
    relayMcpLaunchArgs(choice.cliId),
    store.getSettings(),
  ]);
  const prompt = buildLegPrompt({
    task: { id: taskId, title: task.task.title, file: task.file },
    docsFolder: folder.docsFolder,
    legNo: request.legNo,
    continuation: request.continuation,
    budget: request.budget,
    dependsOn: task.task.depends,
    commitPerTask: relay.options.commitPerTask,
    mcp: mcpArgs.length > 0,
    planFirst: request.planFirst,
  });
  const { command, promptInCommand } = buildLegCommand({
    cliId: choice.cliId,
    shellKind: shellKindFor(shell, process.platform),
    choice,
    planFirst: request.planFirst,
    afterPlanMode: relay.options.afterPlanMode,
    hookSettingsPath,
    mcpArgs,
    prompt: prompt.replace(/\s*\n+\s*/g, ' ').trim(),
    launchDefaults: settings.cliLaunchDefaults?.[choice.cliId],
  });
  if (!command) throw new Error(`${cli.name} has no launch command.`);

  const tabId = randomUUID();
  const title = `${taskId} · ${cli.name}`;
  agentStatus.pin({ sessionId: tabId, projectId: project.id, cliId: choice.cliId, title });
  const created = await createTerminalSession(
    {
      sessionId: tabId,
      shell,
      cwd: project.folderPath,
      initialInput: `${command}\r`,
      projectId: project.id,
      cliId: choice.cliId,
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

  if (!promptInCommand) {
    void deliverWhenReady(prompt, {
      subscribe: (listener) => subscribeTerminalOutput(tabId, listener),
      write: (data) => writeToShell(tabId, data),
    }).then((delivered) => {
      if (delivered) return;
      clipboard.writeText(prompt);
      showOsNotification({
        title: `${cli.name} did not come up for ${taskId}`,
        body: 'The prompt is on your clipboard. Paste it in the tab once the CLI is running.',
        route: `/workspace/${project.id}?session=${encodeURIComponent(tabId)}`,
      });
    });
  }

  const pickLabel = launchPickLabel(choice.cliId, {
    model: choice.model ?? undefined,
    effort: (choice.effort ?? undefined) as EffortLevel | undefined,
  });
  return {
    tabId,
    handoffMtimeAtStart,
    hooks: isClaude && hookSettingsPath !== null,
    tab: {
      projectId: project.id,
      tabId,
      legId: request.legId,
      cliId: choice.cliId,
      title,
      runLabel: pickLabel ? `Leg ${request.legNo} · ${pickLabel}` : `Leg ${request.legNo}`,
      cwd: project.folderPath,
    },
  };
}
