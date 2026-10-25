import type {
  ApplyResult,
  CreateVideoInput,
  EditOp,
  EditResponse,
  GenerationDetail,
  GenerationView,
  HistoryEntryView,
  MoveResult,
  OpenVideoResult,
  ProjectStorageView,
  RecipeView,
  RenderEstimateView,
  RenderJobView,
  RenderToolsView,
  RootCheckView,
  SaveRecipeInput,
  SaveSceneFilesInput,
  SceneCheckView,
  SceneCodeView,
  StartEditInput,
  StartRenderInput,
  StartScenarioInput,
  StartSceneInput,
  StudioDocument,
  StudioEvent,
  StudioSettingsPatch,
  StudioSettingsView,
  StyleReferenceView,
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
    setSceneHosts: (projectId: string, hosts: string[]): Promise<ProjectStorageView> =>
      ipcRenderer.invoke(IPC.studio.setSceneHosts, { projectId, hosts }),
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

/** Studio's scene code (E33): animate with AI, read, edit by hand, go back, check. */
export function createStudioScenes() {
  return {
    animate: (input: StartSceneInput): Promise<GenerationView> =>
      ipcRenderer.invoke(IPC.studioScenes.animate, input),
    code: (videoId: string, sceneId: string): Promise<SceneCodeView> =>
      ipcRenderer.invoke(IPC.studioScenes.code, { videoId, sceneId }),
    saveFiles: (input: SaveSceneFilesInput): Promise<EditResponse> =>
      ipcRenderer.invoke(IPC.studioScenes.saveFiles, input),
    useRevision: (videoId: string, sceneId: string, revisionId: number): Promise<EditResponse> =>
      ipcRenderer.invoke(IPC.studioScenes.useRevision, { videoId, sceneId, revisionId }),
    check: (videoId: string, sceneId: string): Promise<SceneCheckView> =>
      ipcRenderer.invoke(IPC.studioScenes.check, { videoId, sceneId }),
    thumbnail: (videoId: string, treeHash: string): Promise<string | null> =>
      ipcRenderer.invoke(IPC.studioScenes.thumbnail, { videoId, treeHash }),
    styleReference: (input: {
      styleId: string;
      aspect: string;
      language: string;
    }): Promise<StyleReferenceView> => ipcRenderer.invoke(IPC.studioScenes.styleReference, input),
    checkStyle: (input: {
      styleId: string;
      aspect: string;
      language: string;
    }): Promise<SceneCheckView> => ipcRenderer.invoke(IPC.studioScenes.checkStyle, input),
  };
}

/** Studio rendering (E34): what can be rendered here, the render queue, and finished files. */
export function createStudioRender() {
  const ref = (jobId: string) => ({ jobId });
  return {
    tools: (): Promise<RenderToolsView> => ipcRenderer.invoke(IPC.studioRender.tools),
    estimate: (videoId: string): Promise<RenderEstimateView> =>
      ipcRenderer.invoke(IPC.studioRender.estimate, { videoId }),
    start: (input: StartRenderInput): Promise<RenderJobView> =>
      ipcRenderer.invoke(IPC.studioRender.start, input),
    jobs: (videoId?: string): Promise<RenderJobView[]> =>
      ipcRenderer.invoke(IPC.studioRender.jobs, videoId ? { videoId } : {}),
    cancel: (jobId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioRender.cancel, ref(jobId)),
    retry: (jobId: string): Promise<RenderJobView> =>
      ipcRenderer.invoke(IPC.studioRender.retry, ref(jobId)),
    remove: (jobId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioRender.remove, ref(jobId)),
    reveal: (jobId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioRender.reveal, ref(jobId)),
    openFile: (jobId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioRender.openFile, ref(jobId)),
  };
}

/** Studio's AI runs (E32): scenarios, edits by typing, their records, and saved recipes. */
export function createStudioAi() {
  const ref = (videoId: string, generationId: string) => ({ videoId, generationId });
  return {
    startScenario: (input: StartScenarioInput): Promise<GenerationView> =>
      ipcRenderer.invoke(IPC.studioAi.startScenario, input),
    startEdit: (input: StartEditInput): Promise<GenerationView> =>
      ipcRenderer.invoke(IPC.studioAi.startEdit, input),
    retry: (videoId: string, generationId: string): Promise<GenerationView> =>
      ipcRenderer.invoke(IPC.studioAi.retry, ref(videoId, generationId)),
    cancel: (videoId: string, generationId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioAi.cancel, ref(videoId, generationId)),
    generations: (videoId: string, limit: number): Promise<GenerationView[]> =>
      ipcRenderer.invoke(IPC.studioAi.generations, { videoId, limit }),
    generationDetail: (videoId: string, generationId: string): Promise<GenerationDetail> =>
      ipcRenderer.invoke(IPC.studioAi.generationDetail, ref(videoId, generationId)),
    applyProposal: (videoId: string, generationId: string): Promise<EditResponse> =>
      ipcRenderer.invoke(IPC.studioAi.applyProposal, ref(videoId, generationId)),
    discardProposal: (videoId: string, generationId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioAi.discardProposal, ref(videoId, generationId)),
    recipes: (): Promise<RecipeView[]> => ipcRenderer.invoke(IPC.studioAi.recipes),
    saveRecipe: (input: SaveRecipeInput): Promise<RecipeView> =>
      ipcRenderer.invoke(IPC.studioAi.saveRecipe, input),
    deleteRecipe: (recipeId: string): Promise<void> =>
      ipcRenderer.invoke(IPC.studioAi.deleteRecipe, { recipeId }),
  };
}
