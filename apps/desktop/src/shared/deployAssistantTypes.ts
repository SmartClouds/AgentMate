import type { EffortLevel } from '@runova/core';
import type { SshAgentHistoryRun, SshAgentProgress } from './apiTypes';
import type {
  AssistantMode,
  AssistantModeInfo,
  ExecLine,
  JournalLine,
} from './deploy/protocol/generated/Runova.ServerCore.Contracts';

/**
 * The Deploy AI and the logs center (E09), between the renderer and the main process. The AI
 * runs the SSH AI's loop with the server core as its shell; what it is pointed at (a problem, a
 * container) comes along as context, and the main process reads the container's facts and log
 * itself rather than trusting text from the window.
 */

export interface DeployAssistantContextInput {
  /** A few words for the drawer's chip and the prompt ("Crash loop: newsletter-sender-1"). */
  title: string;
  /** Plain facts, one per entry (a problem's detail). */
  facts?: string[];
  /** A container to look up: its facts (env names only) and the end of its log go in the prompt. */
  containerId?: string;
}

/**
 * A Runova project whose code runs on the server, for an agent CLI to work in. The main process
 * looks its folder up by id; a path from the window is never used.
 */
export interface DeployAssistantProjectInput {
  projectId: string;
  /** Lets the CLI edit files in the folder, not only read them. */
  allowEdits: boolean;
}

/**
 * The app (a compose stack) the user has open, which the AI works on unless they say otherwise.
 * Only its id comes from the window: the main process reads its services, containers and logs.
 */
export interface DeployAssistantAppInput {
  stackId: string;
}

/** An app a chat was about, kept with the chat so it can be named and attached again. */
export interface DeployAssistantAppRef {
  stackId: string;
  name: string;
}

export interface DeployAssistantStartInput {
  serverId: string;
  prompt: string;
  /** An agent CLI decides each step; none uses the provider from Settings. */
  cliId?: string | null;
  modelId?: string | null;
  effort?: EffortLevel | null;
  context?: DeployAssistantContextInput;
  /**
   * Carry on from the server's last run (stopped, finished or failed): the AI is told what
   * happened in it. Without it the run starts a new chat.
   */
  continuePrevious?: boolean;
  /**
   * Carry on a past chat the user picked from the history, by its newest run. Takes the place of
   * `continuePrevious`.
   */
  continueFromRunId?: string;
  /** Only with a CLI: the provider from Settings cannot open files. */
  project?: DeployAssistantProjectInput;
  app?: DeployAssistantAppInput;
  /**
   * Absolute paths of files the user pasted or dropped into the box. Images go to the AI as
   * images, text files go into the task.
   */
  attachments?: string[];
}

/** The run's state, as the SSH AI reports it. `progress.sessionId` is the run's key. */
export interface DeployAssistantProgressEvent {
  serverId: string;
  progress: SshAgentProgress;
}

/** Output of the command that is running, as the core streams it (redacted). */
export interface DeployAssistantOutputEvent {
  serverId: string;
  command: string;
  lines: ExecLine[];
}

export interface DeployAssistantModeInput {
  serverId: string;
  mode: AssistantMode;
  /** Turning auto-run on needs a step-up; these make it on the way. */
  password?: string;
  totpCode?: string;
}

export interface DeployAssistantState {
  /** Whether a run is going on this server. */
  running: boolean;
  /** Its last progress, so a window opened later shows where it is. */
  progress: SshAgentProgress | null;
  context: DeployAssistantContextInput | null;
  history: SshAgentHistoryRun[];
}

/** A past Deploy AI chat on a server, as its history lists it. */
export interface DeployAssistantChatSummary {
  /** Its newest run, which a continued chat picks up from. */
  runId: string;
  /** What the user first asked. */
  title: string;
  startedAt: number;
  /** When anything last happened in it. */
  updatedAt: number;
  status: SshAgentHistoryRun['status'];
  /** How many times the user asked: the first question and each follow-up. */
  turns: number;
  aiLabel: string;
  app?: DeployAssistantAppRef;
}

/** Which chat to read or delete. */
export interface DeployAssistantChatInput {
  serverId: string;
  runId: string;
}

export type { AssistantModeInfo };

/** A systemd unit's journal, followed or read once. */
export interface DeployJournalWatchInput {
  serverId: string;
  unit: string;
  lines?: number;
  sinceUnixMs?: number;
  follow: boolean;
}

export interface DeployJournalEvent {
  subscriptionId: string;
  serverId: string;
  unit: string;
  lines: JournalLine[];
  ended?: { error?: string };
}
