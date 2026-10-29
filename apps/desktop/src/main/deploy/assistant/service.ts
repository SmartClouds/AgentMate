import { buildDeployAssistantPrompt, type DeployAssistantContext } from '@runova/core';
import type { SshAgentProgress } from '../../../shared/apiTypes';
import type {
  AssistantMode,
  AssistantModeInfo,
  ExecApproval,
} from '../../../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type { ICoreHub } from '../../../shared/deploy/protocol/generated/TypedSignalR.Client/Runova.ServerCore.Contracts';
import type {
  DeployAssistantContextInput,
  DeployAssistantModeInput,
  DeployAssistantOutputEvent,
  DeployAssistantProgressEvent,
  DeployAssistantStartInput,
  DeployAssistantState,
} from '../../../shared/deployAssistantTypes';
import { IPC } from '../../../shared/ipcChannels';
import {
  answerSshTaskInput,
  approveSshTaskCommand,
  cliPreamble,
  cliRunArgs,
  continuedTaskContext,
  continueSshTask,
  getSshTaskHistory,
  isSshTaskRunning,
  sendSshTaskMessage,
  skipSshTaskCommand,
  startAgentTask,
  stopSshTask,
  type TaskTarget,
} from '../../agents/sshTaskRunner';
import { ADMIN_ROLES, type CoreCallDeps, callCore } from '../coreCalls';
import type { DeployDocker } from '../docker';
import { coreExecutor } from './coreExecutor';

/**
 * The Deploy AI (E09 T5, T7): the SSH AI's loop with the server core as its shell. Its modes are
 * the core's, per session: "approve every command" (the default) proposes each command and runs
 * it with a signed approval once the user agrees; "auto-run diagnostics" (a step-up to turn on)
 * sends each command unsigned and lets the core decide, which it only allows for its read-only
 * allowlist; anything else comes back as a proposal like any other. One run per server.
 */

const LOG_TAIL = 100;

export interface DeployAssistantDeps extends CoreCallDeps {
  approve: (serverId: string, hub: ICoreHub, command: string) => Promise<ExecApproval>;
  serverName: (serverId: string) => Promise<string>;
  docker: Pick<DeployDocker, 'inspect' | 'logTail'>;
  /** To the main window. */
  send: (
    channel: string,
    payload: DeployAssistantProgressEvent | DeployAssistantOutputEvent,
  ) => void;
}

/** A run's key in the loop, apart from every terminal session id. */
export function assistantKey(serverId: string): string {
  return `deploy:${serverId}`;
}

export class DeployAssistant {
  private readonly modes = new Map<string, AssistantMode>();
  private readonly contexts = new Map<string, DeployAssistantContextInput>();
  private readonly progress = new Map<string, SshAgentProgress>();

  constructor(private readonly deps: DeployAssistantDeps) {}

  async mode(serverId: string): Promise<AssistantModeInfo> {
    const info = await callCore(this.deps, serverId, (hub) => hub.getAssistantMode());
    this.modes.set(serverId, info.mode);
    return info;
  }

  async setMode(input: DeployAssistantModeInput): Promise<AssistantModeInfo> {
    const info = await callCore(
      this.deps,
      input.serverId,
      async (hub) => {
        if (input.mode === 'approveEveryCommand') return hub.disableAutoRunDiagnostics();
        if (input.password || input.totpCode) {
          await hub.stepUp({
            ...(input.password ? { password: input.password } : {}),
            ...(input.totpCode ? { totpCode: input.totpCode } : {}),
          });
        }
        return hub.enableAutoRunDiagnostics();
      },
      { stepUpFor: ADMIN_ROLES },
    );
    this.modes.set(input.serverId, info.mode);
    return info;
  }

  async start(input: DeployAssistantStartInput): Promise<void> {
    const { serverId } = input;
    const key = assistantKey(serverId);
    if (isSshTaskRunning(key)) throw new Error('The AI is already working on this server.');
    // Asking the core first also checks the role: only Admins may run commands.
    await this.mode(serverId);
    const serverName = await this.deps.serverName(serverId);
    const context = input.context ? await this.gather(serverId, input.context) : undefined;
    const target: TaskTarget = {
      kind: 'core',
      description: `the server "${serverName}" through its Runova server core`,
      label: 'Deploy AI',
      isConnected: () => true,
      subscribeExit: () => () => undefined,
      endedMessage: 'Runova is closing.',
    };
    // Newest first: the run this one picks up from, when the user carries on rather than
    // starting a new chat.
    const previous = input.continuePrevious ? getSshTaskHistory(key)[0] : undefined;
    this.progress.delete(serverId);
    if (input.context) this.contexts.set(serverId, input.context);
    else this.contexts.delete(serverId);
    startAgentTask(
      {
        key,
        prompt: input.prompt,
        target,
        ...(previous
          ? { continuedFromRunId: previous.id, previousContext: continuedTaskContext(previous.id) }
          : {}),
        // In auto-run mode nothing waits here: the core runs its allowlist and refuses the rest,
        // which the loop then proposes. The mode is read each step, so a change applies at once.
        policy: () => ({ pause: this.modes.get(serverId) !== 'autoRunDiagnostics' }),
        executor: coreExecutor(
          {
            links: this.deps.links,
            approve: this.deps.approve,
            onLines: (command, lines) =>
              this.deps.send(IPC.deployAssistant.onOutput, { serverId, command, lines }),
          },
          serverId,
        ),
        buildPrompt: ({ task, transcript, viaCli }) =>
          buildDeployAssistantPrompt({
            serverName,
            task,
            transcript,
            ...(viaCli ? { preamble: cliPreamble(target) } : {}),
            ...(context ? { context } : {}),
          }),
        cliId: input.cliId ?? null,
        runArgs: cliRunArgs({
          sessionId: key,
          prompt: input.prompt,
          mode: 'approve-all',
          cliId: input.cliId ?? null,
          modelId: input.modelId ?? null,
          effort: input.effort ?? null,
        }),
      },
      (progress) => {
        this.progress.set(serverId, progress);
        this.deps.send(IPC.deployAssistant.onProgress, { serverId, progress });
      },
    );
  }

  state(serverId: string): DeployAssistantState {
    const key = assistantKey(serverId);
    return {
      running: isSshTaskRunning(key),
      progress: this.progress.get(serverId) ?? null,
      context: this.contexts.get(serverId) ?? null,
      history: getSshTaskHistory(key),
    };
  }

  approve(serverId: string): void {
    approveSshTaskCommand(assistantKey(serverId));
  }

  skip(serverId: string): void {
    skipSshTaskCommand(assistantKey(serverId));
  }

  answer(serverId: string, answer: string): void {
    answerSshTaskInput(assistantKey(serverId), answer);
  }

  /** A message for a run that is still going, read at its next step. False once it is over. */
  message(serverId: string, text: string): boolean {
    return sendSshTaskMessage(assistantKey(serverId), text);
  }

  continue(serverId: string): void {
    continueSshTask(assistantKey(serverId));
  }

  stop(serverId: string): void {
    stopSshTask(assistantKey(serverId));
  }

  /** What the prompt says about the container: read here, never taken from the window. */
  private async gather(
    serverId: string,
    input: DeployAssistantContextInput,
  ): Promise<DeployAssistantContext> {
    const context: DeployAssistantContext = { title: input.title, facts: input.facts ?? [] };
    if (!input.containerId) return context;
    const facts = [...(input.facts ?? [])];
    try {
      const details = await this.deps.docker.inspect(serverId, input.containerId);
      const { summary } = details;
      context.container = {
        name: summary.name,
        image: summary.image,
        state: summary.state,
        status: summary.status,
        health: summary.health,
        ...(summary.composeProject ? { composeProject: summary.composeProject } : {}),
        ...(summary.composeService ? { composeService: summary.composeService } : {}),
        restartCount: details.restartCount,
        ...(details.exitCode === undefined ? {} : { exitCode: details.exitCode }),
        envKeys: details.envKeys,
      };
    } catch (error) {
      facts.push(`The app could not inspect the container: ${(error as Error).message}`);
    }
    try {
      const lines = await this.deps.docker.logTail({
        serverId,
        containerId: input.containerId,
        tail: LOG_TAIL,
      });
      context.log = {
        source: `the log of ${context.container?.name ?? input.containerId}`,
        lines: lines.map((line) => `${line.stream === 'stderr' ? 'err' : 'out'} ${line.text}`),
      };
    } catch (error) {
      facts.push(`The app could not read the container's log: ${(error as Error).message}`);
    }
    context.facts = facts;
    return context;
  }
}
