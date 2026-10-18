import { ipcRenderer } from 'electron';
import type {
  ErrorConnectInput,
  ErrorConnectionSummary,
  ErrorIssueDetail,
  ErrorIssuePage,
  ErrorIssuePrompt,
  ErrorIssueQuery,
  ErrorIssueRef,
  ErrorIssueSummary,
  ErrorProjectLink,
  ErrorStatusChange,
  ErrorTokenCheck,
  ErrorTokenCheckInput,
  ErrorTrackingChangedEvent,
  RemoteProject,
} from '../shared/errorTrackingTypes';
import { IPC } from '../shared/ipcChannels';

/**
 * Error tracking (E24). A token goes in through checkToken, addConnection and replaceToken and
 * never comes back out; everything else only reads what the provider recorded.
 */
export function createErrorTracking() {
  return {
    checkToken: (input: ErrorTokenCheckInput): Promise<ErrorTokenCheck> =>
      ipcRenderer.invoke(IPC.errorTracking.checkToken, input),
    addConnection: (input: ErrorConnectInput): Promise<ErrorConnectionSummary> =>
      ipcRenderer.invoke(IPC.errorTracking.addConnection, input),
    listConnections: (): Promise<ErrorConnectionSummary[]> =>
      ipcRenderer.invoke(IPC.errorTracking.listConnections),
    removeConnection: (connectionId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.errorTracking.removeConnection, connectionId),
    replaceToken: (connectionId: string, token: string): Promise<ErrorConnectionSummary> =>
      ipcRenderer.invoke(IPC.errorTracking.replaceToken, connectionId, token),
    remoteProjects: (connectionId: string): Promise<RemoteProject[]> =>
      ipcRenderer.invoke(IPC.errorTracking.remoteProjects, connectionId),
    environments: (filter?: { projectId?: string }): Promise<string[]> =>
      ipcRenderer.invoke(IPC.errorTracking.environments, filter),
    listLinks: (filter?: { projectId?: string }): Promise<ErrorProjectLink[]> =>
      ipcRenderer.invoke(IPC.errorTracking.listLinks, filter),
    setLinks: (projectId: string, links: ErrorProjectLink[]): Promise<ErrorProjectLink[]> =>
      ipcRenderer.invoke(IPC.errorTracking.setLinks, projectId, links),
    listIssues: (query: ErrorIssueQuery): Promise<ErrorIssuePage> =>
      ipcRenderer.invoke(IPC.errorTracking.listIssues, query),
    getIssue: (ref: ErrorIssueRef): Promise<ErrorIssueDetail> =>
      ipcRenderer.invoke(IPC.errorTracking.getIssue, ref),
    setIssueStatus: (change: ErrorStatusChange): Promise<ErrorIssueSummary> =>
      ipcRenderer.invoke(IPC.errorTracking.setIssueStatus, change),
    fixPrompt: (ref: ErrorIssueRef): Promise<ErrorIssuePrompt> =>
      ipcRenderer.invoke(IPC.errorTracking.fixPrompt, ref),
    onChanged: (callback: (event: ErrorTrackingChangedEvent) => void): (() => void) => {
      const listener = (
        _event: Electron.IpcRendererEvent,
        payload: ErrorTrackingChangedEvent,
      ): void => callback(payload);
      ipcRenderer.on(IPC.errorTracking.onChanged, listener);
      return () => ipcRenderer.removeListener(IPC.errorTracking.onChanged, listener);
    },
  };
}
