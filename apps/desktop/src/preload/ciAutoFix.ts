import { ipcRenderer } from 'electron';
import type {
  AutoFixSession,
  AutoFixStartInput,
  AutoFixStartResult,
  AutoFixTabEvent,
} from '../shared/ciAutoFixTypes';
import { IPC } from '../shared/ipcChannels';

function subscribe<T>(channel: string, callback: (payload: T) => void): () => void {
  const listener = (_event: Electron.IpcRendererEvent, payload: T): void => callback(payload);
  ipcRenderer.on(channel, listener);
  return () => ipcRenderer.removeListener(channel, listener);
}

/**
 * CI auto-fix. Main owns every session: it follows the run, starts the agent tab, commits and
 * pushes. The renderer switches it on, shows where each session stands, and acts on it by id.
 */
export function createCiAutoFix() {
  return {
    list: (): Promise<AutoFixSession[]> => ipcRenderer.invoke(IPC.ciAutoFix.list),
    start: (input: AutoFixStartInput): Promise<AutoFixStartResult> =>
      ipcRenderer.invoke(IPC.ciAutoFix.start, input),
    stop: (id: string): Promise<AutoFixSession | null> =>
      ipcRenderer.invoke(IPC.ciAutoFix.stop, id),
    /** Commits and pushes the agent's work now, without waiting for it to look finished. */
    commitNow: (id: string): Promise<AutoFixSession | null> =>
      ipcRenderer.invoke(IPC.ciAutoFix.commitNow, id),
    retry: (id: string): Promise<AutoFixSession | null> =>
      ipcRenderer.invoke(IPC.ciAutoFix.retry, id),
    dismiss: (id: string): Promise<boolean> => ipcRenderer.invoke(IPC.ciAutoFix.dismiss, id),
    onChanged: (callback: (sessions: AutoFixSession[]) => void): (() => void) =>
      subscribe(IPC.ciAutoFix.onChanged, callback),
    onTab: (callback: (event: AutoFixTabEvent) => void): (() => void) =>
      subscribe(IPC.ciAutoFix.onTab, callback),
  };
}
