import type { AgentStatus } from '../workspace/agentStatus.js';
import type { RelayTaskStatus } from './types.js';

/** When a relay that was added to the board, rather than started, begins. */
export type RelayTrigger =
  | { kind: 'now' }
  | { kind: 'at'; at: number }
  | { kind: 'after-task'; projectId: string; taskId: string }
  | { kind: 'after-session'; sessionId: string; label?: string };

export interface TriggerContext {
  now: number;
  /** A task's status, or null when the task no longer exists. */
  taskStatus: (projectId: string, taskId: string) => RelayTaskStatus | null;
  /** A terminal session's agent status, or `gone` when the tab was closed. */
  sessionState: (sessionId: string) => AgentStatus | 'gone';
}

export type TriggerVerdict = { ready: true } | { ready: false; problem?: string };

/** A session counts as finished once it stops working: done, idle, ended or closed. */
const SESSION_FINISHED: ReadonlySet<AgentStatus | 'gone'> = new Set([
  'done',
  'idle',
  'exited',
  'gone',
]);

export function triggerVerdict(trigger: RelayTrigger, context: TriggerContext): TriggerVerdict {
  switch (trigger.kind) {
    case 'now':
      return { ready: true };
    case 'at':
      return context.now >= trigger.at ? { ready: true } : { ready: false };
    case 'after-task': {
      const status = context.taskStatus(trigger.projectId, trigger.taskId);
      if (status === null) {
        return {
          ready: false,
          problem: `${trigger.taskId} no longer exists, so this never starts.`,
        };
      }
      return status === 'done' ? { ready: true } : { ready: false };
    }
    case 'after-session':
      return SESSION_FINISHED.has(context.sessionState(trigger.sessionId))
        ? { ready: true }
        : { ready: false };
  }
}

export function describeTrigger(
  trigger: RelayTrigger,
  options: { formatTime?: (at: number) => string } = {},
): string {
  switch (trigger.kind) {
    case 'now':
      return 'Starts now';
    case 'at': {
      const format = options.formatTime ?? ((at: number) => `at ${new Date(at).toLocaleString()}`);
      return `Starts ${format(trigger.at)}`;
    }
    case 'after-task':
      return `Starts when ${trigger.taskId} is done`;
    case 'after-session':
      return `Starts when ${trigger.label ?? 'that session'} finishes`;
  }
}
