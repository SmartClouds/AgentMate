import { ipcRenderer } from 'electron';
import type {
  FileSite,
  FileSiteInput,
  FilesBrowseInput,
  FilesBrowseResult,
  FilesChangesSnapshot,
  FilesDeployInput,
  FilesHistoryEntry,
  FilesNeedsReviewEvent,
  FilesPlanInput,
  FilesPlanView,
  FilesProgressEvent,
  FilesRunResult,
  FilesSitesChangedEvent,
  FilesTestInput,
  FilesTestResult,
} from '../shared/deployFilesTypes';
import { IPC } from '../shared/ipcChannels';
import type { SshHostKeyStatus } from '../shared/sshHostKey';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

export type FilesIgnoreCheck = { ok: true } | { ok: false; line: number; reason: string };

/**
 * FTP and SFTP sites (E23). A password or key passphrase goes in through `create`, `update` and
 * `test` and never comes back out. Failures carry a `[files:code]` tag (see
 * shared/deployFilesErrors.ts).
 */
export function createDeployFiles(subscribe: Subscribe) {
  const channels = IPC.deployFiles;
  return {
    list: (): Promise<FileSite[]> => ipcRenderer.invoke(channels.list),
    get: (siteId: string): Promise<FileSite | null> => ipcRenderer.invoke(channels.get, siteId),
    create: (input: FileSiteInput): Promise<FileSite> => ipcRenderer.invoke(channels.create, input),
    update: (siteId: string, input: FileSiteInput): Promise<FileSite> =>
      ipcRenderer.invoke(channels.update, siteId, input),
    remove: (siteId: string): Promise<void> => ipcRenderer.invoke(channels.remove, siteId),
    test: (input: FilesTestInput): Promise<FilesTestResult> =>
      ipcRenderer.invoke(channels.test, input),
    browseRemote: (input: FilesBrowseInput): Promise<FilesBrowseResult> =>
      ipcRenderer.invoke(channels.browseRemote, input),
    pickLocalFolder: (defaultPath: string | null): Promise<string | null> =>
      ipcRenderer.invoke(channels.pickLocalFolder, defaultPath),
    validateIgnore: (patterns: string[]): Promise<FilesIgnoreCheck> =>
      ipcRenderer.invoke(channels.validateIgnore, patterns),
    subscribe: (siteId: string): Promise<FilesChangesSnapshot> =>
      ipcRenderer.invoke(channels.subscribe, siteId),
    unsubscribe: (siteId: string): Promise<void> =>
      ipcRenderer.invoke(channels.unsubscribe, siteId),
    changes: (siteId: string): Promise<FilesChangesSnapshot> =>
      ipcRenderer.invoke(channels.changes, siteId),
    plan: (input: FilesPlanInput): Promise<FilesPlanView> =>
      ipcRenderer.invoke(channels.plan, input),
    deploy: (input: FilesDeployInput): Promise<FilesRunResult> =>
      ipcRenderer.invoke(channels.deploy, input),
    cancel: (siteId: string): Promise<void> => ipcRenderer.invoke(channels.cancel, siteId),
    history: (siteId: string): Promise<FilesHistoryEntry[]> =>
      ipcRenderer.invoke(channels.history, siteId),
    forgetBase: (siteId: string): Promise<void> => ipcRenderer.invoke(channels.forgetBase, siteId),
    setDeployOnSave: (siteId: string, enabled: boolean): Promise<FileSite> =>
      ipcRenderer.invoke(channels.setDeployOnSave, siteId, enabled),
    hostKeyStatus: (siteId: string): Promise<SshHostKeyStatus> =>
      ipcRenderer.invoke(channels.hostKeyStatus, siteId),
    trustHostKey: (siteId: string, fingerprint: string): Promise<void> =>
      ipcRenderer.invoke(channels.trustHostKey, siteId, fingerprint),
    trustCertificate: (siteId: string, fingerprint256: string): Promise<void> =>
      ipcRenderer.invoke(channels.trustCertificate, siteId, fingerprint256),
    onChanges: (callback: (snapshot: FilesChangesSnapshot) => void): (() => void) =>
      subscribe(channels.onChanges, callback),
    onProgress: (callback: (event: FilesProgressEvent) => void): (() => void) =>
      subscribe(channels.onProgress, callback),
    onRunFinished: (callback: (result: FilesRunResult) => void): (() => void) =>
      subscribe(channels.onRunFinished, callback),
    onNeedsReview: (callback: (event: FilesNeedsReviewEvent) => void): (() => void) =>
      subscribe(channels.onNeedsReview, callback),
    onSitesChanged: (callback: (event: FilesSitesChangedEvent) => void): (() => void) =>
      subscribe(channels.onSitesChanged, callback),
  };
}
