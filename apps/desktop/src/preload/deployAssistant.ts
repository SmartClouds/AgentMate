import { ipcRenderer } from 'electron';
import type { AssistantModeInfo } from '../shared/deploy/protocol/generated/Runova.ServerCore.Contracts';
import type {
  DeployAssistantModeInput,
  DeployAssistantOutputEvent,
  DeployAssistantProgressEvent,
  DeployAssistantStartInput,
  DeployAssistantState,
  DeployJournalEvent,
  DeployJournalWatchInput,
} from '../shared/deployAssistantTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * The Deploy AI (E09), one run per server. Admins only: anyone else gets `[core:forbidden]`.
 * Turning auto-run diagnostics on needs a step-up (`[core:stepUpRequired]` without one).
 */
export function createDeployAssistant(subscribe: Subscribe) {
  return {
    start: (input: DeployAssistantStartInput): Promise<void> =>
      ipcRenderer.invoke(IPC.deployAssistant.start, input),
    /** Runs the proposed command, with an approval this computer signs for exactly that text. */
    approve: (serverId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployAssistant.approve, serverId),
    skip: (serverId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployAssistant.skip, serverId),
    answer: (serverId: string, answer: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployAssistant.answer, serverId, answer),
    /** Tells a run that is going something, read at its next step. False once it is over. */
    message: (serverId: string, text: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployAssistant.message, serverId, text),
    /** Picks a paused run back up. */
    resume: (serverId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployAssistant.resume, serverId),
    stop: (serverId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployAssistant.stop, serverId),
    state: (serverId: string): Promise<DeployAssistantState> =>
      ipcRenderer.invoke(IPC.deployAssistant.state, serverId),
    getMode: (serverId: string): Promise<AssistantModeInfo> =>
      ipcRenderer.invoke(IPC.deployAssistant.getMode, serverId),
    setMode: (input: DeployAssistantModeInput): Promise<AssistantModeInfo> =>
      ipcRenderer.invoke(IPC.deployAssistant.setMode, input),
    onProgress: (cb: (event: DeployAssistantProgressEvent) => void): (() => void) =>
      subscribe(IPC.deployAssistant.onProgress, cb),
    onOutput: (cb: (event: DeployAssistantOutputEvent) => void): (() => void) =>
      subscribe(IPC.deployAssistant.onOutput, cb),
  };
}

/** The logs center's journald source (E09); containers, stacks and sites use their own groups. */
export function createDeployLogs(subscribe: Subscribe) {
  return {
    watchJournal: (input: DeployJournalWatchInput): Promise<string> =>
      ipcRenderer.invoke(IPC.deployLogs.watchJournal, input),
    unwatchJournal: (subscriptionId: string): Promise<boolean> =>
      ipcRenderer.invoke(IPC.deployLogs.unwatchJournal, subscriptionId),
    onJournal: (cb: (event: DeployJournalEvent) => void): (() => void) =>
      subscribe(IPC.deployLogs.onJournal, cb),
  };
}
