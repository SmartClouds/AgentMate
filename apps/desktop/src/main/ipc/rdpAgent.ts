import { type IpcMainInvokeEvent, ipcMain, type WebContents } from 'electron';
import type {
  RdpAgentHistoryRun,
  RdpAgentProgress,
  StartRdpAgentTaskInput,
} from '../../shared/apiTypes';
import { IPC } from '../../shared/ipcChannels';
import {
  answerRdpTaskInput,
  approveRdpTaskAction,
  continueRdpTask,
  getRdpTaskHistory,
  notifyRdpTaskWaiting,
  sendRdpTaskMessage,
  skipRdpTaskAction,
  startRdpTask,
  stopRdpTask,
} from '../agents/rdpTaskRunner';
import { registerRdpAgentBridgeHandlers } from '../rdp/agentBridge';
import { sendToContents } from './send';

/** The window that started each session's task, so progress events go back to it. */
const owners = new Map<string, WebContents>();

function forwardProgress(progress: RdpAgentProgress): void {
  sendToContents(owners.get(progress.sessionId), IPC.rdpAgent.onProgress, progress);
  // A paused run is still going, and whatever it reports after Continue needs somewhere to go.
  const paused = progress.phase === 'error' && progress.canContinue;
  if (
    !paused &&
    (progress.phase === 'finished' || progress.phase === 'error' || progress.phase === 'stopped')
  ) {
    owners.delete(progress.sessionId);
  }
}

export function registerRdpAgentHandlers(): void {
  registerRdpAgentBridgeHandlers();

  ipcMain.handle(
    IPC.rdpAgent.start,
    (event: IpcMainInvokeEvent, input: StartRdpAgentTaskInput): void => {
      owners.set(input.sessionId, event.sender);
      startRdpTask(input, forwardProgress);
    },
  );

  ipcMain.handle(IPC.rdpAgent.approveAction, (_event, sessionId: string): void => {
    approveRdpTaskAction(sessionId);
  });

  ipcMain.handle(IPC.rdpAgent.skipAction, (_event, sessionId: string): void => {
    skipRdpTaskAction(sessionId);
  });

  ipcMain.handle(
    IPC.rdpAgent.answerNeedsInput,
    (_event, sessionId: string, answer: string): void => {
      answerRdpTaskInput(sessionId, answer);
    },
  );

  ipcMain.handle(IPC.rdpAgent.sendMessage, (_event, sessionId: string, text: string): boolean =>
    sendRdpTaskMessage(sessionId, text),
  );

  ipcMain.handle(IPC.rdpAgent.stop, (_event, sessionId: string): void => {
    stopRdpTask(sessionId);
  });

  ipcMain.handle(IPC.rdpAgent.continue, (_event, sessionId: string): void => {
    continueRdpTask(sessionId);
  });

  ipcMain.handle(IPC.rdpAgent.history, (_event, sessionId: string): RdpAgentHistoryRun[] =>
    getRdpTaskHistory(sessionId),
  );

  ipcMain.handle(
    IPC.rdpAgent.notifyWaiting,
    (_event, sessionId: string, title: string): Promise<void> =>
      notifyRdpTaskWaiting(sessionId, title),
  );
}
