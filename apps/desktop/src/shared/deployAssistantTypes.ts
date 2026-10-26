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

export interface DeployAssistantStartInput {
  serverId: string;
  prompt: string;
  /** An agent CLI decides each step; none uses the provider from Settings. */
  cliId?: string | null;
  modelId?: string | null;
  effort?: EffortLevel | null;
  context?: DeployAssistantContextInput;
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
