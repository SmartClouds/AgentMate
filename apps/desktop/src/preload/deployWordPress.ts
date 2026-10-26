import { ipcRenderer } from 'electron';
import type {
  DeployWordPressAuditQuery,
  DeployWordPressConnectInput,
  DeployWordPressCreateProjectInput,
  DeployWordPressDeployResult,
  DeployWordPressDisconnectInput,
  DeployWordPressIgnoreInput,
  DeployWordPressItemsInput,
  DeployWordPressLinkProjectInput,
  DeployWordPressLinkProjectResult,
  DeployWordPressLocalChanges,
  DeployWordPressLocalItem,
  DeployWordPressPlan,
  DeployWordPressPlanInput,
  DeployWordPressProgressEvent,
  DeployWordPressPullResult,
  DeployWordPressRemoteFile,
  DeployWordPressRemoteFileInput,
  DeployWordPressRollbackInput,
  DeployWordPressRunInput,
  DeployWordPressSaveZipResult,
  DeployWordPressSettingsInput,
  DeployWordPressSite,
  DeployWordPressSiteInfo,
  DeployWordPressUpdateConnectorResult,
  Project,
  WpAuditEntry,
  WpDeployRecord,
  WpItem,
} from '../shared/deployWordPressTypes';
import { IPC } from '../shared/ipcChannels';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * WordPress sites connected through the Runova Connector plugin (E19 to E21). A connection key
 * goes in through `connect` and never comes back out. Failures carry a `[wp:code]` tag (see
 * shared/wordpressErrors.ts). Long calls take an `operationId` the renderer picks, and report
 * their steps on `onProgress` under it.
 */
export function createDeployWordPress(subscribe: Subscribe) {
  return {
    listSites: (): Promise<DeployWordPressSite[]> =>
      ipcRenderer.invoke(IPC.deployWordPress.listSites),
    connect: (input: DeployWordPressConnectInput): Promise<DeployWordPressSite> =>
      ipcRenderer.invoke(IPC.deployWordPress.connect, input),
    disconnect: (input: DeployWordPressDisconnectInput): Promise<void> =>
      ipcRenderer.invoke(IPC.deployWordPress.disconnect, input),
    updateSettings: (input: DeployWordPressSettingsInput): Promise<DeployWordPressSite> =>
      ipcRenderer.invoke(IPC.deployWordPress.updateSettings, input),
    siteInfo: (siteId: string): Promise<DeployWordPressSiteInfo> =>
      ipcRenderer.invoke(IPC.deployWordPress.siteInfo, siteId),
    listItems: (siteId: string): Promise<WpItem[]> =>
      ipcRenderer.invoke(IPC.deployWordPress.listItems, siteId),
    history: (siteId: string): Promise<WpDeployRecord[]> =>
      ipcRenderer.invoke(IPC.deployWordPress.history, siteId),
    rollback: (input: DeployWordPressRollbackInput): Promise<DeployWordPressDeployResult> =>
      ipcRenderer.invoke(IPC.deployWordPress.rollback, input),
    audit: (query: DeployWordPressAuditQuery): Promise<WpAuditEntry[]> =>
      ipcRenderer.invoke(IPC.deployWordPress.audit, query),
    planPull: (input: DeployWordPressPlanInput): Promise<DeployWordPressPlan> =>
      ipcRenderer.invoke(IPC.deployWordPress.planPull, input),
    pull: (input: DeployWordPressRunInput): Promise<DeployWordPressPullResult> =>
      ipcRenderer.invoke(IPC.deployWordPress.pull, input),
    planDeploy: (input: DeployWordPressPlanInput): Promise<DeployWordPressPlan> =>
      ipcRenderer.invoke(IPC.deployWordPress.planDeploy, input),
    deploy: (input: DeployWordPressRunInput): Promise<DeployWordPressDeployResult> =>
      ipcRenderer.invoke(IPC.deployWordPress.deploy, input),
    /** Stops a running operation at its next safe point; a deploy already applying rolls back. */
    cancel: (operationId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployWordPress.cancel, operationId),
    createProject: (input: DeployWordPressCreateProjectInput): Promise<Project> =>
      ipcRenderer.invoke(IPC.deployWordPress.createProject, input),
    setProjectItems: (input: DeployWordPressItemsInput): Promise<Project> =>
      ipcRenderer.invoke(IPC.deployWordPress.setProjectItems, input),
    /** Saves what the project leaves out of its pulls and deploys, replacing the whole list. */
    setProjectIgnore: (input: DeployWordPressIgnoreInput): Promise<Project> =>
      ipcRenderer.invoke(IPC.deployWordPress.setProjectIgnore, input),
    /** The theme and plugin folders found in a project's wp-content, for picking new ones. */
    localItems: (projectId: string): Promise<DeployWordPressLocalItem[]> =>
      ipcRenderer.invoke(IPC.deployWordPress.localItems, projectId),
    linkProject: (
      input: DeployWordPressLinkProjectInput,
    ): Promise<DeployWordPressLinkProjectResult> =>
      ipcRenderer.invoke(IPC.deployWordPress.linkProject, input),
    unlinkProject: (projectId: string): Promise<Project> =>
      ipcRenderer.invoke(IPC.deployWordPress.unlinkProject, projectId),
    localChanges: (projectId: string): Promise<DeployWordPressLocalChanges> =>
      ipcRenderer.invoke(IPC.deployWordPress.localChanges, projectId),
    remoteFile: (input: DeployWordPressRemoteFileInput): Promise<DeployWordPressRemoteFile> =>
      ipcRenderer.invoke(IPC.deployWordPress.remoteFile, input),
    /** Asks where to save the bundled plugin zip; `saved: false` when that was cancelled. */
    saveConnectorZip: (): Promise<DeployWordPressSaveZipResult> =>
      ipcRenderer.invoke(IPC.deployWordPress.saveConnectorZip),
    /**
     * Replaces the connector on the site with the version bundled in this app. Only for a site
     * whose connector reports `selfUpdate`; the site puts the old files back if it stops working.
     */
    updateConnector: (siteId: string): Promise<DeployWordPressUpdateConnectorResult> =>
      ipcRenderer.invoke(IPC.deployWordPress.updateConnector, siteId),
    onProgress: (callback: (event: DeployWordPressProgressEvent) => void): (() => void) =>
      subscribe(IPC.deployWordPress.onProgress, callback),
  };
}
