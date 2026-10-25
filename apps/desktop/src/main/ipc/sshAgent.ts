import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import type {
  SshAgentHistoryRun,
  SshAgentProgress,
  StartSshAgentTaskInput,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  answerSshTaskInput,
  answerSshTaskPassword,
  approveSshTaskCommand,
  clearSshServerTaskHistory,
  continueSshTask,
  ensureSshHistoryRestored,
  getSshServerTaskHistory,
  getSshTaskHistory,
  notifySshTaskWaiting,
  sendSshTaskMessage,
  skipSshTaskCommand,
  startSshTask,
  stopSshTask,
} from '../agents/sshTaskRunner';
import { sendToContents } from './send';
import { onSshServerRemoved } from './ssh';

/** The window that started each session's task, so progress events go back to it. */
const owners = new Map<string, WebContents>();

function forwardProgress(progress: SshAgentProgress): void {
  sendToContents(owners.get(progress.sessionId), IPC.sshAgent.onProgress, progress);
  // A paused run is still going, and whatever it reports after Continue needs somewhere to go.
  const paused = progress.phase === 'error' && progress.canContinue;
  if (
    !paused &&
    (progress.phase === 'finished' || progress.phase === 'error' || progress.phase === 'stopped')
  ) {
    owners.delete(progress.sessionId);
  }
}

export function registerSshAgentHandlers(): void {
  ipcMain.handle(
    IPC.sshAgent.start,
    async (event: IpcMainInvokeEvent, input: StartSshAgentTaskInput): Promise<void> => {
      // A task continued from before a restart is only found once the saved history is read.
      if (input.continueFromRunId) await ensureSshHistoryRestored();
      owners.set(input.sessionId, event.sender);
      startSshTask(input, forwardProgress);
    },
  );

  ipcMain.handle(
    IPC.sshAgent.answerPassword,
    (_event, sessionId: string, approved: boolean): void => {
      answerSshTaskPassword(sessionId, approved);
    },
  );

  ipcMain.handle(IPC.sshAgent.approveCommand, (_event, sessionId: string): void => {
    approveSshTaskCommand(sessionId);
  });

  ipcMain.handle(IPC.sshAgent.skipCommand, (_event, sessionId: string): void => {
    skipSshTaskCommand(sessionId);
  });

  ipcMain.handle(
    IPC.sshAgent.answerNeedsInput,
    (_event, sessionId: string, answer: string): void => {
      answerSshTaskInput(sessionId, answer);
    },
  );

  ipcMain.handle(IPC.sshAgent.sendMessage, (_event, sessionId: string, text: string): boolean =>
    sendSshTaskMessage(sessionId, text),
  );

  ipcMain.handle(IPC.sshAgent.stop, (_event, sessionId: string): void => {
    stopSshTask(sessionId);
  });

  ipcMain.handle(IPC.sshAgent.continue, (_event, sessionId: string): void => {
    continueSshTask(sessionId);
  });

  ipcMain.handle(IPC.sshAgent.history, (_event, sessionId: string): SshAgentHistoryRun[] =>
    getSshTaskHistory(sessionId),
  );

  ipcMain.handle(
    IPC.sshAgent.serverHistory,
    async (_event, serverId: unknown): Promise<SshAgentHistoryRun[]> => {
      if (typeof serverId !== 'string' || !serverId) return [];
      await ensureSshHistoryRestored();
      return getSshServerTaskHistory(serverId);
    },
  );

  ipcMain.handle(IPC.sshAgent.clearServerHistory, async (_event, serverId: unknown) => {
    if (typeof serverId === 'string' && serverId) await clearSshServerTaskHistory(serverId);
  });

  // A server that is gone takes its AI history with it, on disk too.
  onSshServerRemoved((serverId) => void clearSshServerTaskHistory(serverId));

  ipcMain.handle(
    IPC.sshAgent.notifyWaiting,
    (_event, sessionId: string, tabTitle: string): Promise<void> =>
      notifySshTaskWaiting(sessionId, tabTitle),
  );
}
