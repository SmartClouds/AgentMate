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
  return {
    list: (): Promise<FileSite[]> => ipcRenderer.invoke(IPC.deployFiles.list),
    get: (siteId: string): Promise<FileSite | null> =>
      ipcRenderer.invoke(IPC.deployFiles.get, siteId),
    create: (input: FileSiteInput): Promise<FileSite> =>
      ipcRenderer.invoke(IPC.deployFiles.create, input),
    update: (siteId: string, input: FileSiteInput): Promise<FileSite> =>
      ipcRenderer.invoke(IPC.deployFiles.update, siteId, input),
    remove: (siteId: string): Promise<void> => ipcRenderer.invoke(IPC.deployFiles.remove, siteId),
    test: (input: FilesTestInput): Promise<FilesTestResult> =>
      ipcRenderer.invoke(IPC.deployFiles.test, input),
    browseRemote: (input: FilesBrowseInput): Promise<FilesBrowseResult> =>
      ipcRenderer.invoke(IPC.deployFiles.browseRemote, input),
    pickLocalFolder: (defaultPath: string | null): Promise<string | null> =>
      ipcRenderer.invoke(IPC.deployFiles.pickLocalFolder, defaultPath),
    validateIgnore: (patterns: string[]): Promise<FilesIgnoreCheck> =>
      ipcRenderer.invoke(IPC.deployFiles.validateIgnore, patterns),
    subscribe: (siteId: string): Promise<FilesChangesSnapshot> =>
      ipcRenderer.invoke(IPC.deployFiles.subscribe, siteId),
    unsubscribe: (siteId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployFiles.unsubscribe, siteId),
    changes: (siteId: string): Promise<FilesChangesSnapshot> =>
      ipcRenderer.invoke(IPC.deployFiles.changes, siteId),
    plan: (input: FilesPlanInput): Promise<FilesPlanView> =>
      ipcRenderer.invoke(IPC.deployFiles.plan, input),
    deploy: (input: FilesDeployInput): Promise<FilesRunResult> =>
      ipcRenderer.invoke(IPC.deployFiles.deploy, input),
    cancel: (siteId: string): Promise<void> => ipcRenderer.invoke(IPC.deployFiles.cancel, siteId),
    history: (siteId: string): Promise<FilesHistoryEntry[]> =>
      ipcRenderer.invoke(IPC.deployFiles.history, siteId),
    forgetBase: (siteId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployFiles.forgetBase, siteId),
    setDeployOnSave: (siteId: string, enabled: boolean): Promise<FileSite> =>
      ipcRenderer.invoke(IPC.deployFiles.setDeployOnSave, siteId, enabled),
    hostKeyStatus: (siteId: string): Promise<SshHostKeyStatus> =>
      ipcRenderer.invoke(IPC.deployFiles.hostKeyStatus, siteId),
    trustHostKey: (siteId: string, fingerprint: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployFiles.trustHostKey, siteId, fingerprint),
    trustCertificate: (siteId: string, fingerprint256: string): Promise<void> =>
      ipcRenderer.invoke(IPC.deployFiles.trustCertificate, siteId, fingerprint256),
    onChanges: (callback: (snapshot: FilesChangesSnapshot) => void): (() => void) =>
      subscribe(IPC.deployFiles.onChanges, callback),
    onProgress: (callback: (event: FilesProgressEvent) => void): (() => void) =>
      subscribe(IPC.deployFiles.onProgress, callback),
    onRunFinished: (callback: (result: FilesRunResult) => void): (() => void) =>
      subscribe(IPC.deployFiles.onRunFinished, callback),
    onNeedsReview: (callback: (event: FilesNeedsReviewEvent) => void): (() => void) =>
      subscribe(IPC.deployFiles.onNeedsReview, callback),
    onSitesChanged: (callback: (event: FilesSitesChangedEvent) => void): (() => void) =>
      subscribe(IPC.deployFiles.onSitesChanged, callback),
  };
}
