import type {
  ApplyResult,
  CreateVideoInput,
  EditOp,
  EditResponse,
  HistoryEntryView,
  MoveResult,
  OpenVideoResult,
  ProjectStorageView,
  RootCheckView,
  StudioDocument,
  StudioEvent,
  StudioSettingsPatch,
  StudioSettingsView,
  VideoSummary,
} from '@agentmat/studio';
import { ipcRenderer } from 'electron';
import { IPC } from '../shared/ipcChannels';

/** Studio (E31): AI video projects, their storage folders and their edit history. */
export function createStudio() {
  return {
    settings: (): Promise<StudioSettingsView> => ipcRenderer.invoke(IPC.studio.settings),
    updateSettings: (patch: StudioSettingsPatch): Promise<StudioSettingsView> =>
      ipcRenderer.invoke(IPC.studio.updateSettings, patch),
    projectStorage: (projectId: string): Promise<ProjectStorageView> =>
      ipcRenderer.invoke(IPC.studio.projectStorage, { projectId }),
    setProjectRoot: (projectId: string, path: string | null): Promise<ProjectStorageView> =>
      ipcRenderer.invoke(IPC.studio.setProjectRoot, { projectId, path }),
    checkRoot: (path: string, projectId: string | null): Promise<RootCheckView> =>
      ipcRenderer.invoke(IPC.studio.checkRoot, { path, projectId }),
    pickFolder: (defaultPath?: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.studio.pickFolder, { defaultPath }),
    list: (filter?: { projectId?: string | null }): Promise<VideoSummary[]> =>
      ipcRenderer.invoke(IPC.studio.list, filter),
    create: (input: CreateVideoInput): Promise<VideoSummary> =>
      ipcRenderer.invoke(IPC.studio.create, input),
    open: (videoId: string): Promise<OpenVideoResult> =>
      ipcRenderer.invoke(IPC.studio.open, { videoId }),
    takeOver: (videoId: string): Promise<OpenVideoResult> =>
      ipcRenderer.invoke(IPC.studio.takeOver, { videoId }),
    close: (videoId: string): Promise<void> => ipcRenderer.invoke(IPC.studio.close, { videoId }),
    applyEdits: (input: {
      videoId: string;
      baseSeq: number;
      ops: EditOp[];
      label: string;
    }): Promise<ApplyResult> => ipcRenderer.invoke(IPC.studio.apply, input),
    undo: (videoId: string): Promise<EditResponse | null> =>
      ipcRenderer.invoke(IPC.studio.undo, { videoId }),
    redo: (videoId: string): Promise<EditResponse | null> =>
      ipcRenderer.invoke(IPC.studio.redo, { videoId }),
    history: (input: {
      videoId: string;
      before?: number;
      limit: number;
    }): Promise<HistoryEntryView[]> => ipcRenderer.invoke(IPC.studio.history, input),
    version: (videoId: string, seq: number): Promise<StudioDocument> =>
      ipcRenderer.invoke(IPC.studio.version, { videoId, seq }),
    restore: (videoId: string, seq: number): Promise<EditResponse> =>
      ipcRenderer.invoke(IPC.studio.restore, { videoId, seq }),
    addExisting: (folder: string): Promise<VideoSummary> =>
      ipcRenderer.invoke(IPC.studio.addExisting, { folder }),
    locate: (videoId: string, folder: string): Promise<VideoSummary> =>
      ipcRenderer.invoke(IPC.studio.locate, { videoId, folder }),
    removeFromLibrary: (videoId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studio.removeFromLibrary, { videoId }),
    move: (videoId: string, toRoot: string): Promise<MoveResult> =>
      ipcRenderer.invoke(IPC.studio.move, { videoId, toRoot }),
    trashOldFolder: (folder: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studio.trashOldFolder, { folder }),
    revealVideo: (videoId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studio.revealVideo, { videoId }),
    onEvent: (callback: (event: StudioEvent) => void): (() => void) => {
      const listener = (_event: unknown, payload: StudioEvent) => callback(payload);
      ipcRenderer.on(IPC.studio.onEvent, listener);
      return () => ipcRenderer.removeListener(IPC.studio.onEvent, listener);
    },
  };
}
