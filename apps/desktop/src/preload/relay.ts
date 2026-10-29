import type { RelayProposal, RelayTaskStatus } from '@runova/core';
import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type {
  RelayApplyResult,
  RelayBoard,
  RelayCatchUpInput,
  RelayChangedEvent,
  RelayCloseTabEvent,
  RelayContextEvent,
  RelayDecomposeInput,
  RelayLegTabEvent,
  RelayMcpProposal,
  RelayPlannerResult,
  RelayProjectSettings,
  RelayReviseInput,
  RelayRunView,
  RelaySettingsPatch,
  RelaySingleRun,
  RelayStartInput,
  RelayStartResult,
  RelayTaskDetail,
} from '../shared/relayTypes';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * Relay (E26). The renderer names projects, tasks and relays by id; main reads the files, builds
 * every prompt and command, and starts the sessions.
 */
export function createRelay() {
  return {
    board: (projectId: string): Promise<RelayBoard> =>
      ipcRenderer.invoke(IPC.relay.board, projectId),
    task: (projectId: string, taskId: string): Promise<RelayTaskDetail | null> =>
      ipcRenderer.invoke(IPC.relay.task, projectId, taskId),
    setStatus: (projectId: string, taskId: string, status: RelayTaskStatus): Promise<void> =>
      ipcRenderer.invoke(IPC.relay.setStatus, projectId, taskId, status),
    reorder: (projectId: string, taskIds: string[]): Promise<void> =>
      ipcRenderer.invoke(IPC.relay.reorder, projectId, taskIds),
    ensureGuide: (projectId: string, docsFolder?: string): Promise<void> =>
      ipcRenderer.invoke(IPC.relay.ensureGuide, projectId, docsFolder),
    saveSettings: (projectId: string, patch: RelaySettingsPatch): Promise<RelayProjectSettings> =>
      ipcRenderer.invoke(IPC.relay.saveSettings, projectId, patch),
    prepareRun: (projectId: string, taskId: string): Promise<RelaySingleRun> =>
      ipcRenderer.invoke(IPC.relay.prepareRun, projectId, taskId),
    start: (input: RelayStartInput): Promise<RelayStartResult> =>
      ipcRenderer.invoke(IPC.relay.start, input),
    pause: (relayId: string): Promise<void> => ipcRenderer.invoke(IPC.relay.pause, relayId),
    resume: (relayId: string): Promise<void> => ipcRenderer.invoke(IPC.relay.resume, relayId),
    cancel: (relayId: string): Promise<void> => ipcRenderer.invoke(IPC.relay.cancel, relayId),
    markDone: (relayId: string, taskId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.relay.markDone, relayId, taskId),
    runs: (projectId: string): Promise<RelayRunView[]> =>
      ipcRenderer.invoke(IPC.relay.runs, projectId),
    watch: (projectId: string): Promise<void> => ipcRenderer.invoke(IPC.relay.watch, projectId),
    unwatch: (projectId: string): Promise<void> => ipcRenderer.invoke(IPC.relay.unwatch, projectId),
    decompose: (input: RelayDecomposeInput): Promise<RelayPlannerResult> =>
      ipcRenderer.invoke(IPC.relay.decompose, input),
    revise: (input: RelayReviseInput): Promise<RelayPlannerResult> =>
      ipcRenderer.invoke(IPC.relay.revise, input),
    catchUp: (input: RelayCatchUpInput): Promise<RelayPlannerResult> =>
      ipcRenderer.invoke(IPC.relay.catchUp, input),
    cancelPlanner: (requestId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.relay.cancelPlanner, requestId),
    applyProposal: (projectId: string, proposal: RelayProposal): Promise<RelayApplyResult> =>
      ipcRenderer.invoke(IPC.relay.applyProposal, projectId, proposal),
    decideProposal: (proposalId: string, accept: boolean): Promise<RelayApplyResult | null> =>
      ipcRenderer.invoke(IPC.relay.decideProposal, proposalId, accept),
    pendingProposals: (): Promise<RelayMcpProposal[]> =>
      ipcRenderer.invoke(IPC.relay.pendingProposals),
    reconcile: (tabs: { legId: string; tabId: string }[]): Promise<void> =>
      ipcRenderer.invoke(IPC.relay.reconcile, tabs),
    onChanged: (callback: (event: RelayChangedEvent) => void): (() => void) =>
      subscribe(IPC.relay.onChanged, callback),
    onRun: (callback: (run: RelayRunView) => void): (() => void) =>
      subscribe(IPC.relay.onRun, callback),
    onContext: (callback: (event: RelayContextEvent) => void): (() => void) =>
      subscribe(IPC.relay.onContext, callback),
    onLegTab: (callback: (event: RelayLegTabEvent) => void): (() => void) =>
      subscribe(IPC.relay.onLegTab, callback),
    onCloseTab: (callback: (event: RelayCloseTabEvent) => void): (() => void) =>
      subscribe(IPC.relay.onCloseTab, callback),
    onProposal: (callback: (proposal: RelayMcpProposal) => void): (() => void) =>
      subscribe(IPC.relay.onProposal, callback),
    onPlannerOpen: (callback: (requestId: string) => void): (() => void) =>
      subscribe(IPC.relay.onPlannerOpen, callback),
  };
}
