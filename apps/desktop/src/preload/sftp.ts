import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';
import type { SftpBridge } from '../shared/sftpTypes';

type Subscribe = <T>(channel: string, callback: (payload: T) => void) => () => void;

/**
 * The SFTP file manager for saved SSH servers (E25). No secret goes either way: main logs in with
 * the saved server's stored credentials. Failures carry a `[files:code]` or `[ssh:code]` tag (see
 * shared/sftpTypes.ts for what each call answers).
 */
export function createSftp(subscribe: Subscribe): SftpBridge {
  return {
    open: (serverId) => ipcRenderer.invoke(IPC.sftp.open, serverId),
    close: (sessionId) => ipcRenderer.invoke(IPC.sftp.close, sessionId),
    list: (sessionId, path) => ipcRenderer.invoke(IPC.sftp.list, sessionId, path),
    stat: (sessionId, path) => ipcRenderer.invoke(IPC.sftp.stat, sessionId, path),
    mkdir: (sessionId, parentDir, name) =>
      ipcRenderer.invoke(IPC.sftp.mkdir, sessionId, parentDir, name),
    rename: (sessionId, path, newName) =>
      ipcRenderer.invoke(IPC.sftp.rename, sessionId, path, newName),
    remove: (sessionId, paths) => ipcRenderer.invoke(IPC.sftp.remove, sessionId, paths),
    chmod: (sessionId, input) => ipcRenderer.invoke(IPC.sftp.chmod, sessionId, input),
    upload: (sessionId, input) => ipcRenderer.invoke(IPC.sftp.upload, sessionId, input),
    download: (sessionId, input) => ipcRenderer.invoke(IPC.sftp.download, sessionId, input),
    resolveConflict: (sessionId, conflictId, decision) =>
      ipcRenderer.invoke(IPC.sftp.resolveConflict, sessionId, conflictId, decision),
    cancel: (sessionId, target) => ipcRenderer.invoke(IPC.sftp.cancel, sessionId, target),
    retry: (sessionId, target) => ipcRenderer.invoke(IPC.sftp.retry, sessionId, target),
    clearFinished: (sessionId) => ipcRenderer.invoke(IPC.sftp.clearFinished, sessionId),
    queue: (sessionId) => ipcRenderer.invoke(IPC.sftp.queue, sessionId),
    readText: (sessionId, path) => ipcRenderer.invoke(IPC.sftp.readText, sessionId, path),
    writeText: (sessionId, input) => ipcRenderer.invoke(IPC.sftp.writeText, sessionId, input),
    localPlaces: () => ipcRenderer.invoke(IPC.sftp.localPlaces),
    localList: (path) => ipcRenderer.invoke(IPC.sftp.localList, path),
    localMkdir: (parentDir, name) => ipcRenderer.invoke(IPC.sftp.localMkdir, parentDir, name),
    localRename: (path, newName) => ipcRenderer.invoke(IPC.sftp.localRename, path, newName),
    localDelete: (paths, options) => ipcRenderer.invoke(IPC.sftp.localDelete, paths, options),
    onQueue: (callback) => subscribe(IPC.sftp.onQueue, callback),
    onBatchFinished: (callback) => subscribe(IPC.sftp.onBatchFinished, callback),
    onSessionClosed: (callback) => subscribe(IPC.sftp.onSessionClosed, callback),
  };
}
