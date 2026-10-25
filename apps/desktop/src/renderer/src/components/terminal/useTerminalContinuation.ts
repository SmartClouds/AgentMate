import type { SshAgentHistoryRun, SshSavedServer } from '@shared/apiTypes';
import { toast } from 'sonner';
import {
  continueSshAgentTaskFrom,
  isSshAgentActive,
  type SshAskAiPrefill,
  useSshAgentSession,
  useSshAgentStore,
} from '@/stores/sshAgentStore';
import { useTerminalStore } from '@/stores/terminalStore';
import type { AgentRunContinuation } from './AgentHistoryFooter';

/**
 * How the history picks an ended task back up in one terminal tab: continuing starts right there,
 * while Run again and More options hand the task to the Ask AI dialog to look over first.
 */
export function useTerminalContinuation({
  sessionId,
  title,
  target,
  openAskAi,
}: {
  sessionId: string | null;
  title: string;
  target: 'ssh' | 'local';
  /** Opens the Ask AI dialog on this tab, starting from `prefill`. */
  openAskAi: (prefill: SshAskAiPrefill) => void;
}): AgentRunContinuation | null {
  const state = useSshAgentSession(sessionId);
  if (!sessionId) return null;
  return {
    where: title || 'this terminal',
    blockedReason: isSshAgentActive(state)
      ? 'An AI task is already running in this terminal. Stop it or wait for it to end first.'
      : null,
    runAgain: (run: SshAgentHistoryRun) => openAskAi({ run, intent: 'rerun' }),
    moreOptions: (run: SshAgentHistoryRun) => openAskAi({ run, intent: 'continue' }),
    continueWith: async (run, followUp) => {
      try {
        await continueSshAgentTaskFrom(sessionId, target, run, followUp);
        return true;
      } catch (error) {
        toast.error((error as Error).message || 'Could not start the AI task.');
        return false;
      }
    },
  };
}

/**
 * Shows an SSH tab on the server, the task's own if it is still open, another one on the server
 * otherwise, or a new one, and has its Ask AI dialog open on the task. Nothing starts before the
 * user looks it over there, by which time the tab has connected.
 */
export function askAiInServerTab(server: SshSavedServer, prefill: SshAskAiPrefill): void {
  const terminal = useTerminalStore.getState();
  const onServer = terminal.sessions.filter((s) => s.kind === 'ssh' && s.sshServerId === server.id);
  const tabId =
    onServer.find((s) => s.id === prefill.run.sessionId)?.id ??
    onServer[0]?.id ??
    terminal.openSshSession(server);
  useTerminalStore.getState().setActiveSession(tabId);
  useTerminalStore.getState().openDrawer();
  useSshAgentStore.setState({ askAiRequest: { sessionId: tabId, prefill } });
}

/** How the server's history picks a task back up: in an SSH tab on the server, through Ask AI. */
export function serverContinuation(
  server: SshSavedServer,
  onHandedOff: () => void,
): AgentRunContinuation {
  const handOff = (prefill: SshAskAiPrefill): void => {
    askAiInServerTab(server, prefill);
    onHandedOff();
  };
  return {
    where: `an SSH tab on ${server.nickname}`,
    blockedReason: null,
    runAgain: (run) => handOff({ run, intent: 'rerun' }),
    moreOptions: (run) => handOff({ run, intent: 'continue' }),
    continueWith: async (run, followUp) => {
      handOff({ run, intent: 'continue', followUp });
      return true;
    },
  };
}
