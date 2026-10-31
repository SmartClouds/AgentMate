import type { EffortLevel } from '@runova/core';
import { isAbsolute } from 'node:path';
import type { IpcMainInvokeEvent } from 'electron';
import type {
  DeployAssistantAppInput,
  DeployAssistantChatInput,
  DeployAssistantContextInput,
  DeployAssistantModeInput,
  DeployAssistantProjectInput,
  DeployAssistantStartInput,
  DeployJournalWatchInput,
} from '../../shared/deployAssistantTypes';
import { OBJECT_NAME } from '../../shared/dockerNames';
import { IPC } from '../../shared/ipcChannels';
import { MAX_SSH_AGENT_MESSAGE_CHARS } from '../../shared/sshAgentMessage';
import { MAX_TASK_ATTACHMENTS } from '../agents/taskAttachments';
import type { DeployAssistant } from '../deploy/assistant/service';
import type { SubscriptionOwner } from '../deploy/live/subscriptions';
import type { JournalSubscriptions } from '../deploy/logs/journal';
import {
  type DeployIpcRegistry,
  object,
  optionalText,
  serverId,
  stepUpInput,
  text,
} from './deploy';

/**
 * The Deploy AI's and the logs center's channels (E09): `deployAssistant` and `deployLogs`. Like
 * every Deploy group they answer the main window alone, and every argument is checked here
 * (sizes, ids, a unit name the core would accept) before it reaches the service.
 */

export interface DeployAssistantHandlerDeps {
  ipc: DeployIpcRegistry;
  assistant: Pick<
    DeployAssistant,
    | 'start'
    | 'approve'
    | 'skip'
    | 'answer'
    | 'message'
    | 'continue'
    | 'stop'
    | 'state'
    | 'mode'
    | 'setMode'
    | 'chats'
    | 'chat'
    | 'deleteChat'
  >;
  journals: Pick<JournalSubscriptions, 'watch' | 'unwatch'>;
  guard: (event: IpcMainInvokeEvent) => boolean;
  owner: (event: IpcMainInvokeEvent) => SubscriptionOwner;
}

/**
 * Room for whatever the user pastes (a long log, a whole plan). The cap only keeps a broken
 * renderer from flooding the process; a CLI takes a prompt this size on stdin.
 */
const MAX_PROMPT = 200_000;
const MAX_PATH = 1_024;
const MAX_ANSWER = 2_000;
const MAX_TITLE = 200;
const MAX_FACT = 1_000;
const MAX_FACTS = 20;
const CLI_ID = /^[a-z0-9][a-z0-9._-]{0,63}$/;
const EFFORTS: ReadonlySet<string> = new Set(['low', 'medium', 'high', 'xhigh', 'max']);
const UNIT = /^[A-Za-z0-9][A-Za-z0-9@_.:\\-]{0,127}$/;
const PROJECT_ID = /^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/;
const GUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

function optionalId(value: unknown, pattern: RegExp, what: string): string | null {
  if (value === undefined || value === null || value === '') return null;
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`That is not a ${what}.`);
  return value;
}

function context(value: unknown): DeployAssistantContextInput | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, 'what the AI looks at');
  const facts = input.facts;
  if (
    facts !== undefined &&
    (!Array.isArray(facts) ||
      facts.length > MAX_FACTS ||
      !facts.every((fact) => typeof fact === 'string' && fact.length <= MAX_FACT))
  ) {
    throw new Error(`Facts are at most ${MAX_FACTS} lines of text.`);
  }
  const containerId = optionalId(input.containerId, OBJECT_NAME, 'container id or name');
  return {
    title: text(input.title, MAX_TITLE, 'title'),
    ...(facts === undefined ? {} : { facts: facts as string[] }),
    ...(containerId ? { containerId } : {}),
  };
}

function projectInput(value: unknown): DeployAssistantProjectInput | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, 'a project');
  if (typeof input.projectId !== 'string' || !PROJECT_ID.test(input.projectId)) {
    throw new Error('That is not a project.');
  }
  if (typeof input.allowEdits !== 'boolean') throw new Error('Say whether the AI may edit files.');
  return { projectId: input.projectId, allowEdits: input.allowEdits };
}

function appInput(value: unknown): DeployAssistantAppInput | undefined {
  if (value === undefined || value === null) return undefined;
  const input = object(value, 'an app');
  if (typeof input.stackId !== 'string' || !GUID.test(input.stackId)) {
    throw new Error('That is not an app.');
  }
  return { stackId: input.stackId };
}

function attachmentsInput(value: unknown): string[] {
  if (value === undefined || value === null) return [];
  if (
    !Array.isArray(value) ||
    !value.every((path) => typeof path === 'string' && path.length <= MAX_PATH && isAbsolute(path))
  ) {
    throw new Error('Those attachments are not files on this computer.');
  }
  if (value.length > MAX_TASK_ATTACHMENTS) {
    throw new Error(`Attach at most ${MAX_TASK_ATTACHMENTS} files to one task.`);
  }
  return [...new Set(value as string[])];
}

export function startInput(value: unknown): DeployAssistantStartInput {
  const input = object(value, 'a task for the AI');
  if (typeof input.prompt === 'string' && input.prompt.length > MAX_PROMPT) {
    throw new Error(
      `The task is longer than ${MAX_PROMPT.toLocaleString('en-US')} characters. Attach the long part as a file instead.`,
    );
  }
  const prompt = text(input.prompt, MAX_PROMPT, 'task');
  if (!prompt.trim()) throw new Error('Describe what you want the AI to do first.');
  const attachments = attachmentsInput(input.attachments);
  const effort = optionalId(input.effort, /^[a-z]+$/, 'reasoning effort');
  if (effort && !EFFORTS.has(effort)) throw new Error('That is not a reasoning effort.');
  const found = context(input.context);
  const project = projectInput(input.project);
  const app = appInput(input.app);
  const continueFromRunId = optionalId(input.continueFromRunId, GUID, 'chat');
  return {
    serverId: serverId(input.serverId),
    prompt,
    cliId: optionalId(input.cliId, CLI_ID, 'CLI'),
    modelId: optionalId(input.modelId, CLI_ID, 'model'),
    effort: effort as EffortLevel | null,
    ...(found ? { context: found } : {}),
    ...(input.continuePrevious === true ? { continuePrevious: true } : {}),
    ...(project ? { project } : {}),
    ...(app ? { app } : {}),
    ...(continueFromRunId ? { continueFromRunId } : {}),
    ...(attachments.length > 0 ? { attachments } : {}),
  };
}

export function chatInput(value: unknown): DeployAssistantChatInput {
  const input = object(value, 'a chat');
  if (typeof input.runId !== 'string' || !GUID.test(input.runId)) {
    throw new Error('That is not a chat.');
  }
  return { serverId: serverId(input.serverId), runId: input.runId };
}

export function modeInput(value: unknown): DeployAssistantModeInput {
  const input = object(value, 'a mode');
  if (input.mode !== 'approveEveryCommand' && input.mode !== 'autoRunDiagnostics') {
    throw new Error('Approve every command, or auto-run diagnostics.');
  }
  return { ...stepUpInput(value), mode: input.mode };
}

export function journalInput(value: unknown): DeployJournalWatchInput {
  const input = object(value, 'a journal to read');
  if (typeof input.unit !== 'string' || !UNIT.test(input.unit)) {
    throw new Error('Name a systemd unit, such as docker.service or nginx.');
  }
  if (typeof input.follow !== 'boolean') throw new Error('Say whether to follow the journal.');
  const lines = input.lines;
  if (
    lines !== undefined &&
    (!Number.isSafeInteger(lines) || (lines as number) < 0 || (lines as number) > 2_000)
  ) {
    throw new Error('Ask for 0 to 2000 lines.');
  }
  const since = input.sinceUnixMs;
  if (since !== undefined && (!Number.isSafeInteger(since) || (since as number) < 0)) {
    throw new Error('The start time is a time in milliseconds.');
  }
  return {
    serverId: serverId(input.serverId),
    unit: input.unit,
    follow: input.follow,
    ...(lines === undefined ? {} : { lines: lines as number }),
    ...(since === undefined ? {} : { sinceUnixMs: since as number }),
  };
}

export function registerDeployAssistantHandlers(deps: DeployAssistantHandlerDeps): void {
  const { ipc, assistant, journals } = deps;
  const handle = (
    channel: string,
    run: (owner: () => SubscriptionOwner, ...args: unknown[]) => unknown,
  ) => {
    ipc.handle(channel, async (event, ...args) => {
      if (!deps.guard(event)) throw new Error('Deploy is only available in the main window.');
      return run(() => deps.owner(event), ...args);
    });
  };

  handle(IPC.deployAssistant.start, (_owner, value) => assistant.start(startInput(value)));
  handle(IPC.deployAssistant.approve, (_owner, id) => assistant.approve(serverId(id)));
  handle(IPC.deployAssistant.skip, (_owner, id) => assistant.skip(serverId(id)));
  handle(IPC.deployAssistant.answer, (_owner, id, answer) =>
    assistant.answer(serverId(id), optionalText(answer, MAX_ANSWER, 'answer') ?? ''),
  );
  handle(IPC.deployAssistant.message, (_owner, id, message) => {
    const said = text(message, MAX_SSH_AGENT_MESSAGE_CHARS, 'message');
    if (!said.trim()) throw new Error('Type a message first.');
    return assistant.message(serverId(id), said);
  });
  handle(IPC.deployAssistant.resume, (_owner, id) => assistant.continue(serverId(id)));
  handle(IPC.deployAssistant.stop, (_owner, id) => assistant.stop(serverId(id)));
  handle(IPC.deployAssistant.state, (_owner, id) => assistant.state(serverId(id)));
  handle(IPC.deployAssistant.getMode, (_owner, id) => assistant.mode(serverId(id)));
  handle(IPC.deployAssistant.setMode, (_owner, value) => assistant.setMode(modeInput(value)));
  handle(IPC.deployAssistant.chats, (_owner, id) => assistant.chats(serverId(id)));
  handle(IPC.deployAssistant.chat, (_owner, value) => {
    const chat = chatInput(value);
    return assistant.chat(chat.serverId, chat.runId);
  });
  handle(IPC.deployAssistant.deleteChat, (_owner, value) => {
    const chat = chatInput(value);
    return assistant.deleteChat(chat.serverId, chat.runId);
  });

  handle(IPC.deployLogs.watchJournal, (owner, value) =>
    journals.watch(owner(), journalInput(value)),
  );
  handle(IPC.deployLogs.unwatchJournal, (owner, id) => {
    if (typeof id !== 'string' || !GUID.test(id)) throw new Error('That is not a subscription.');
    return journals.unwatch(owner(), id);
  });
}
