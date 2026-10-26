import { createHash } from 'node:crypto';
import { access, cp, mkdir, readdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { hostname as osHostname, totalmem } from 'node:os';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import type { ProposalChange } from '../ai/edit/answer.js';
import type {
  ApplyResult,
  CreateVideoInput,
  EditResponse,
  GenEstimateView,
  GenerationDetail,
  GenerationView,
  GenJobView,
  GenRequest,
  HistoryEntryView,
  ImportResult,
  MediaVariant,
  MediaView,
  MoveResult,
  NarrationJobView,
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
  StudioEvent,
  StudioSettingsPatch,
  StudioSettingsView,
  StyleReferenceView,
  VideoSession,
  VideoSummary,
  VoiceEngineView,
  VoiceProfileView,
  VoiceView,
} from '../api.js';
import type { EditOp } from '../document/ops.js';
import type { StudioDocument } from '../document/schema.js';
import { type Aspect, DESIGN_SIZES } from '../document/schema.js';
import { compareDocuments } from '../history/compare.js';
import { sceneUrl } from '../scenes/url.js';
import { directionOf } from '../text/languages.js';
import { newId, safeFolderName } from '../text/names.js';
import { flicksToSeconds } from '../time/flicks.js';
import type { VoiceEngineId } from '../voice/voices.js';
import {
  createStudioAi,
  type SceneCheckHost,
  type StudioAiHost,
  sceneConfig,
} from './ai/studioAi.js';
import { BlobStore } from './blobs/blobStore.js';
import type { OpenSqlDriver } from './db/sqlDriver.js';
import { createGenJobs } from './gen/genJobs.js';
import { seedBranch } from './history/branch.js';
import { createMediaLibrary } from './media/mediaLibrary.js';
import { acquireVideoLock, type HeldLock, LOCK_FILE, type LockOptions } from './project/lock.js';
import { checkStorageRoot } from './project/storageRoot.js';
import {
  createVideoFolder,
  readVideoManifest,
  StaleEditError,
  VideoStore,
  type VideoStoreDeps,
} from './project/videoStore.js';
import { RecipeStore } from './recipes/recipeStore.js';
import { createStudioRender, type StudioRenderHost } from './render/renderQueue.js';
import { type StudioAssets, studioAssets } from './scenes/assets.js';
import { readTree, type TreeManifest, treeFile, treeFromFiles } from './scenes/codeTree.js';
import { JsonStore } from './settings/jsonStore.js';
import { cloneElevenLabsVoice, deleteElevenLabsVoice } from './voice/engines.js';
import { createLocalVoices } from './voice/localVoices.js';
import { createNarrator } from './voice/narrator.js';
import { createVoiceKeys, type StudioKeyEngine, type StudioVoiceHost } from './voice/voiceKeys.js';
import { type VoiceProfile, VoiceProfiles } from './voice/voiceProfiles.js';

/**
 * Studio's service: the library of videos, where each project keeps them, and the open videos
 * with their edit history. It knows nothing about Electron; the host hands in what it needs
 * (paths, the SQLite binding, the projects it can see) and receives events to pass on to the UI.
 */

export interface HostProject {
  id: string;
  name: string;
  folderPath: string;
}

export interface StudioHost {
  /** Studio's own settings and registry live here (`<userData>/data/studio`). */
  dataDir: string;
  /** The default library folder (`<Videos>/AgentMate Studio`). */
  defaultLibraryRoot: string;
  /** Previews, proxies and render chunks (`<userData>/studio-cache`), kept off synced folders. */
  defaultCacheDir: string;
  /** The app's own install folder, which must never hold videos. */
  appDir: string | null;
  /** Names this copy of AgentMate in a video's lock ("AgentMate" or "AgentMate Dev"). */
  appId: string;
  openDb: OpenSqlDriver;
  projects: { get(id: string): Promise<HostProject | null> | HostProject | null };
  notify(event: StudioEvent): void;
  /** Runs AI CLIs. Without it, Studio works but every AI action says it is unavailable. */
  ai?: StudioAiHost;
  /** Checks scene pages in a real browser. Without it, scenes cannot be animated or checked. */
  scenes?: SceneCheckHost;
  /** Renders videos with ffmpeg and scene windows. Without it, the Render button says why not. */
  render?: StudioRenderHost;
  /** Keys and network for the voice engines. Without it, narration says voices are unavailable. */
  voice?: StudioVoiceHost;
  /**
   * Where Studio's own files (fonts, style scenes, the runtime) are. A host that bundles this
   * package says where it shipped them; others leave it to the package folder.
   */
  packageRoot?: string;
  now?: () => number;
  pid?: number;
  hostname?: string;
  isAlive?: (pid: number) => boolean;
}

const settingsSchema = z.object({
  version: z.literal(1),
  defaultRoot: z.string().nullable(),
  cacheDir: z.string().nullable(),
  cacheCapGb: z.number().int().min(1).max(2000),
  autoResumeRenders: z.boolean(),
  hwEncode: z.boolean(),
  projectRoots: z.record(z.string(), z.string()),
  // Added in E33; older settings files have none, which is the safe default.
  projectSceneHosts: z.record(z.string(), z.array(z.string())).default({}),
});
type SettingsFile = z.infer<typeof settingsSchema>;

const registryEntrySchema = z.object({
  id: z.string(),
  title: z.string(),
  folder: z.string(),
  linkedProjectId: z.string().nullable(),
  createdAt: z.number(),
  lastOpenedAt: z.number().nullable(),
});
type RegistryEntry = z.infer<typeof registryEntrySchema>;
const registrySchema = z.object({
  version: z.literal(1),
  videos: z.record(z.string(), registryEntrySchema),
});
type RegistryFile = z.infer<typeof registrySchema>;

interface Session {
  store: VideoStore;
  lock: HeldLock;
}

/** Studio's part of the app's backup: its settings and recipes files, as they are on disk. */
export interface StudioBackup {
  settings?: unknown;
  recipes?: unknown;
}

export interface StudioService {
  settings(): Promise<StudioSettingsView>;
  updateSettings(patch: StudioSettingsPatch): Promise<StudioSettingsView>;
  projectStorage(input: { projectId: string }): Promise<ProjectStorageView>;
  setProjectRoot(input: { projectId: string; path: string | null }): Promise<ProjectStorageView>;
  setSceneHosts(input: { projectId: string; hosts: string[] }): Promise<ProjectStorageView>;
  /** Hosts the video holding this tree may reach: its project's list, or none. */
  sceneHosts(input: { treeHash: string }): Promise<string[]>;
  checkRoot(input: { path: string; projectId: string | null }): Promise<RootCheckView>;
  pruneProjects(known: ReadonlySet<string>): Promise<void>;
  list(input?: { projectId?: string | null }): Promise<VideoSummary[]>;
  create(input: CreateVideoInput): Promise<VideoSummary>;
  open(input: { videoId: string }): Promise<OpenVideoResult>;
  takeOver(input: { videoId: string }): Promise<OpenVideoResult>;
  close(input: { videoId: string }): Promise<void>;
  apply(input: {
    videoId: string;
    baseSeq: number;
    ops: EditOp[];
    label: string;
  }): Promise<ApplyResult>;
  undo(input: { videoId: string }): Promise<EditResponse | null>;
  redo(input: { videoId: string }): Promise<EditResponse | null>;
  history(input: { videoId: string; before?: number; limit: number }): Promise<HistoryEntryView[]>;
  version(input: { videoId: string; seq: number }): Promise<StudioDocument>;
  restore(input: { videoId: string; seq: number }): Promise<EditResponse>;
  addExisting(input: { folder: string }): Promise<VideoSummary>;
  locate(input: { videoId: string; folder: string }): Promise<VideoSummary>;
  removeFromLibrary(input: { videoId: string }): Promise<void>;
  move(input: { videoId: string; toRoot: string }): Promise<MoveResult>;
  startScenario(input: StartScenarioInput): Promise<GenerationView>;
  startEdit(input: StartEditInput): Promise<GenerationView>;
  retryGeneration(input: GenerationRef): Promise<GenerationView>;
  cancelGeneration(input: GenerationRef): Promise<void>;
  generations(input: { videoId: string; limit: number }): Promise<GenerationView[]>;
  generationDetail(input: GenerationRef): Promise<GenerationDetail>;
  applyProposal(input: GenerationRef): Promise<EditResponse>;
  discardProposal(input: GenerationRef): Promise<void>;
  recipes(): Promise<RecipeView[]>;
  saveRecipe(input: SaveRecipeInput): Promise<RecipeView>;
  deleteRecipe(input: { recipeId: string }): Promise<void>;
  /** Every save of a recipe, newest first (E39). */
  recipeVersions(input: { recipeId: string }): Promise<RecipeView[]>;
  recipeVersion(input: { recipeId: string; version: number }): Promise<RecipeView>;
  /** The recipe with its versions, as the text of a `.amrecipe.json` file. */
  exportRecipe(input: { recipeId: string }): Promise<{ name: string; text: string }>;
  /** Adds the recipe in a `.amrecipe.json` file's text as a new recipe. */
  importRecipe(input: { text: string }): Promise<RecipeView>;
  startScene(input: StartSceneInput): Promise<GenerationView>;
  sceneCode(input: { videoId: string; sceneId: string }): Promise<SceneCodeView>;
  saveSceneFiles(input: SaveSceneFilesInput): Promise<EditResponse>;
  useCodeRevision(input: {
    videoId: string;
    sceneId: string;
    revisionId: number;
  }): Promise<EditResponse>;
  checkScene(input: { videoId: string; sceneId: string }): Promise<SceneCheckView>;
  /** A style's reference scene, stored in the shared library, with the address to preview it. */
  styleReference(input: {
    styleId: string;
    aspect: Aspect;
    language: string;
  }): Promise<StyleReferenceView>;
  /** Checks a style's reference scene in a real browser (the styles gallery, and the tests). */
  checkStyleReference(input: {
    styleId: string;
    aspect: Aspect;
    language: string;
  }): Promise<SceneCheckView>;
  importMedia(input: { videoId: string; paths: string[] }): Promise<ImportResult>;
  media(input: { videoId: string }): Promise<MediaView[]>;
  /** A file to serve for the preview: the original, or a preview file once it is made. */
  mediaFile(input: {
    videoId: string;
    hash: string;
    variant: MediaVariant;
  }): Promise<string | null>;
  voiceEngines(): Promise<VoiceEngineView[]>;
  voices(input: { engine: VoiceEngineId; lang: string }): Promise<VoiceView[]>;
  setVoiceKey(input: {
    engine: StudioKeyEngine;
    key: string | null;
    region?: string;
  }): Promise<VoiceEngineView[]>;
  /** Speaks scenes with a voice, one run per video at a time; progress comes as events. */
  speak(input: {
    videoId: string;
    sceneIds: string[];
    voiceRef: string;
  }): Promise<NarrationJobView>;
  narrationJobs(input: { videoId: string }): Promise<NarrationJobView[]>;
  cancelNarration(input: { videoId: string; jobId: string }): Promise<void>;
  /** Puts a recording made in the app on a scene as its narration. */
  recordNarration(input: {
    videoId: string;
    sceneId: string;
    bytes: Uint8Array;
    mimeType: string;
  }): Promise<EditResponse>;
  /** Captions a scene from its narration, where its words are spoken when it has a voice. */
  captionScene(input: { videoId: string; sceneId: string }): Promise<EditResponse>;
  voiceProfiles(): Promise<VoiceProfileView[]>;
  /** What a take says and how long it is, before a profile is made from it. */
  transcribeTake(input: {
    bytes: Uint8Array;
    mimeType: string;
    lang: string;
  }): Promise<{ text: string; seconds: number }>;
  createVoiceProfile(input: {
    bytes: Uint8Array;
    mimeType: string;
    name: string;
    lang: string;
    transcript: string;
    consent: true;
  }): Promise<VoiceProfileView>;
  updateVoiceProfile(input: {
    profileId: string;
    name?: string;
    transcript?: string;
  }): Promise<VoiceProfileView>;
  /** Uploads the profile's recording to ElevenLabs as an instant voice clone. */
  cloneVoiceProfile(input: {
    profileId: string;
    acknowledgeUpload: true;
  }): Promise<VoiceProfileView>;
  /** Removes a profile, and its clone in ElevenLabs first when there is one. */
  removeVoiceProfile(input: { profileId: string }): Promise<void>;
  /** What changed between two versions of a video, as an AI proposal shows it (E39). */
  compareVersions(input: { videoId: string; from: number; to: number }): Promise<ProposalChange[]>;
  /** The text files of a scene's code tree, for comparing two revisions of it. */
  treeFiles(input: {
    videoId: string;
    treeHash: string;
  }): Promise<{ path: string; text: string | null }[]>;
  /** Studio's settings and recipes for the app's backup (E39); videos and media are not in it. */
  backupData(): Promise<StudioBackup>;
  /** Why a backup's Studio section cannot be restored, or null when it can. */
  checkBackup(data: StudioBackup): string | null;
  /** Puts back a backup's Studio settings and recipes; check it first. */
  restoreBackup(data: StudioBackup): Promise<void>;
  /** Starts a new video from a version of this one, next to it, with only the files it uses. */
  branchVideo(input: { videoId: string; seq: number }): Promise<VideoSummary>;
  /** What a generated picture or clip will cost, before anything is sent. */
  genEstimate(input: GenRequest & { videoId: string }): Promise<GenEstimateView>;
  /** Starts one the person confirmed at `confirmedUsd`; it bills their account. */
  startGen(input: GenRequest & { videoId: string; confirmedUsd: number }): Promise<GenJobView>;
  genJobs(input: { videoId: string }): Promise<GenJobView[]>;
  cancelGen(input: { jobId: string }): Promise<void>;
  renderTools(): Promise<RenderToolsView>;
  renderEstimate(input: { videoId: string }): Promise<RenderEstimateView>;
  startRender(input: StartRenderInput): Promise<RenderJobView>;
  renderJobs(input: { videoId?: string }): Promise<RenderJobView[]>;
  cancelRender(input: { jobId: string }): Promise<void>;
  retryRender(input: { jobId: string }): Promise<RenderJobView>;
  removeRender(input: { jobId: string }): Promise<void>;
  /** Picks up renders the app stopped in the middle of; the host calls it once the app is ready. */
  resumeRenders(): Promise<void>;
  /** A code tree's thumbnail as PNG bytes, or null before it has been checked. */
  thumbnail(input: { videoId: string; treeHash: string }): Promise<Uint8Array | null>;
  /**
   * A file of a scene's code tree, for the scene server: looked up in the open videos and in the
   * shared library (the style reference scenes). Null when no one has that tree or that file.
   */
  sceneFile(input: { treeHash: string; path: string }): Promise<Uint8Array | null>;
  /** The shared blob store, for trees that belong to no video. */
  readonly libraryBlobs: BlobStore;
  /** Studio's own files, where this host keeps them. */
  readonly assets: StudioAssets;
  shutdown(): Promise<void>;
  /** Drops an open video as a crash would, keeping its lock file. Tests only. */
  abandonForTest(videoId: string): void;
}

type GenerationRef = { videoId: string; generationId: string };

const LOCK_STALE_MS = 30_000;
const LOCK_HEARTBEAT_MS = 10_000;

function defaultIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    // EPERM means it exists but belongs to someone else.
    return (error as NodeJS.ErrnoException).code === 'EPERM';
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await access(path);
    return true;
  } catch {
    return false;
  }
}

function firstError(check: RootCheckView): string {
  return check.problems.find((p) => p.level === 'error')?.message ?? 'That folder cannot be used.';
}

/** Every file under `dir` with its size, relative to `dir`. */
async function listFiles(
  dir: string,
  skip: (name: string) => boolean,
): Promise<Map<string, number>> {
  const files = new Map<string, number>();
  const walk = async (folder: string) => {
    for (const entry of await readdir(folder, { withFileTypes: true })) {
      if (skip(entry.name)) continue;
      const full = join(folder, entry.name);
      if (entry.isDirectory()) await walk(full);
      else files.set(relative(dir, full), (await stat(full)).size);
    }
  };
  await walk(dir);
  return files;
}

/** How long a style's reference scene runs in the gallery. */
const REFERENCE_SECONDS = 6;

/** Files whose content the code view shows and edits. */
const TEXT_FILE = /\.(html|js|mjs|css|json|svg|txt)$/i;

const skipOnCopy = (name: string) => name === LOCK_FILE || name.includes('.tmp-');

export function createStudioService(host: StudioHost): StudioService {
  const now = host.now ?? Date.now;
  const settingsStore = new JsonStore<SettingsFile>(
    join(host.dataDir, 'settings.json'),
    settingsSchema,
    () => ({
      version: 1,
      defaultRoot: null,
      cacheDir: null,
      cacheCapGb: 20,
      autoResumeRenders: true,
      hwEncode: true,
      projectRoots: {},
      projectSceneHosts: {},
    }),
    now,
  );
  const registry = new JsonStore<RegistryFile>(
    join(host.dataDir, 'registry.json'),
    registrySchema,
    () => ({ version: 1, videos: {} }),
    now,
  );
  const sessions = new Map<string, Session>();
  /** Videos the editor closed while an AI run was still working on them. */
  const closeAfterRun = new Set<string>();
  const recipeStore = new RecipeStore(join(host.dataDir, 'recipes.json'), now, newId);
  const libraryBlobs = new BlobStore(join(host.dataDir, 'blobs'));
  const assets = studioAssets(host.packageRoot);
  /** Trees never change, so a manifest read once is good for the whole run. */
  const manifests = new Map<string, TreeManifest>();

  const lockOptions = (takeOverStale = false): LockOptions => ({
    appId: host.appId,
    pid: host.pid ?? process.pid,
    host: host.hostname ?? osHostname(),
    now,
    staleMs: LOCK_STALE_MS,
    heartbeatMs: LOCK_HEARTBEAT_MS,
    isAlive: host.isAlive ?? defaultIsAlive,
    takeOverStale,
  });

  const storeDeps = (folder: string): VideoStoreDeps => ({
    openDb: host.openDb,
    now,
    network: process.platform === 'win32' && folder.startsWith('\\\\'),
  });

  function view(file: SettingsFile): StudioSettingsView {
    const defaultRoot = file.defaultRoot ?? host.defaultLibraryRoot;
    return {
      defaultRoot,
      defaultRootIsCustom: file.defaultRoot !== null,
      standaloneRoot: join(defaultRoot, 'Standalone'),
      cacheDir: file.cacheDir ?? host.defaultCacheDir,
      cacheCapGb: file.cacheCapGb,
      autoResumeRenders: file.autoResumeRenders,
      hwEncode: file.hwEncode,
    };
  }

  async function requireProject(projectId: string): Promise<HostProject> {
    const project = await host.projects.get(projectId);
    if (!project) throw new Error('That project is not in AgentMate any more.');
    return project;
  }

  async function projectRoot(
    projectId: string,
  ): Promise<{ root: string; isCustom: boolean; project: HostProject }> {
    const project = await requireProject(projectId);
    const file = await settingsStore.read();
    const custom = file.projectRoots[projectId];
    if (custom) return { root: custom, isCustom: true, project };
    const base = file.defaultRoot ?? host.defaultLibraryRoot;
    return {
      root: join(base, 'Projects', safeFolderName(project.name, 'project')),
      isCustom: false,
      project,
    };
  }

  async function check(path: string, projectFolder: string | null): Promise<RootCheckView> {
    return checkStorageRoot(path, { projectFolder, appDir: host.appDir });
  }

  async function storageView(projectId: string): Promise<ProjectStorageView> {
    const { root, isCustom, project } = await projectRoot(projectId);
    const sceneHosts = (await settingsStore.read()).projectSceneHosts[projectId] ?? [];
    return { projectId, root, isCustom, check: await check(root, project.folderPath), sceneHosts };
  }

  async function summarize(entry: RegistryEntry): Promise<VideoSummary> {
    return { ...entry, missing: !(await exists(join(entry.folder, 'studio.json'))) };
  }

  async function entry(videoId: string): Promise<RegistryEntry> {
    const found = (await registry.read()).videos[videoId];
    if (!found) throw new Error('That video is not in the Studio library.');
    return found;
  }

  async function putEntry(value: RegistryEntry): Promise<void> {
    await registry.mutate((file) => {
      file.videos[value.id] = value;
    });
    host.notify({ type: 'library-changed' });
  }

  /** Reference scenes are stored once per run; their trees never change while it runs. */
  const references = new Map<string, Promise<string>>();

  async function styleReference(input: {
    styleId: string;
    aspect: Aspect;
    language: string;
  }): Promise<StyleReferenceView> {
    let treeHash = references.get(input.styleId);
    if (!treeHash) {
      treeHash = assets
        .styleReference(input.styleId)
        .then(async (files) => (await treeFromFiles(files, libraryBlobs)).treeHash);
      references.set(input.styleId, treeHash);
      treeHash.catch(() => references.delete(input.styleId));
    }
    const hash = await treeHash;
    const size = DESIGN_SIZES[input.aspect];
    const url = sceneUrl(hash, {
      duration: REFERENCE_SECONDS,
      width: size.width,
      height: size.height,
      lang: input.language,
      dir: directionOf(input.language),
      seed: input.styleId,
    });
    return { styleId: input.styleId, treeHash: hash, url };
  }

  function sceneOf(store: VideoStore, sceneId: string) {
    const scene = store.document.scenario.scenes.find((s) => s.id === sceneId);
    if (!scene) throw new Error('That scene is not in the video any more.');
    return scene;
  }

  function session(videoId: string): Session {
    const found = sessions.get(videoId);
    if (!found) throw new Error('That video is not open.');
    return found;
  }

  function response(store: VideoStore, seq: number, document: StudioDocument): EditResponse {
    return { seq, document, status: store.status() };
  }

  /** Keeps the library's title in step after an edit, and tells the UI what changed. */
  async function afterEdit(videoId: string, store: VideoStore): Promise<void> {
    host.notify({ type: 'video-changed', videoId, seq: store.seq });
    const current = (await registry.read()).videos[videoId];
    if (current && current.title !== store.document.title) {
      await putEntry({ ...current, title: store.document.title });
    }
  }

  async function sessionView(videoId: string, store: VideoStore): Promise<VideoSession> {
    return {
      video: await summarize(await entry(videoId)),
      document: store.document,
      status: store.status(),
    };
  }

  async function openWith(videoId: string, takeOverStale: boolean): Promise<OpenVideoResult> {
    const existing = sessions.get(videoId);
    if (existing) {
      closeAfterRun.delete(videoId);
      return { state: 'open', session: await sessionView(videoId, existing.store) };
    }
    const found = await entry(videoId);
    const summary = await summarize(found);
    if (summary.missing) return { state: 'missing', video: summary };

    const locked = await acquireVideoLock(found.folder, lockOptions(takeOverStale));
    if (!locked.ok) {
      const { appId, host: machine, pid, heartbeatAt } = locked.holder;
      return {
        state: 'locked',
        holder: { appId, host: machine, pid, heartbeatAt },
        stale: locked.stale,
      };
    }
    let store: VideoStore;
    try {
      store = await VideoStore.open(found.folder, storeDeps(found.folder));
    } catch (error) {
      await locked.lock.release();
      return { state: 'error', message: error instanceof Error ? error.message : String(error) };
    }
    sessions.set(videoId, { store, lock: locked.lock });
    media.prepare(videoId, store);
    // Pictures and clips that finished while the video was closed come in now.
    void gen.importPending(videoId).catch(() => undefined);
    await putEntry({ ...found, title: store.manifest.title, lastOpenedAt: now() });
    return { state: 'open', session: await sessionView(videoId, store) };
  }

  const ai = createStudioAi({
    ai: host.ai,
    scenes: host.scenes,
    now,
    newId,
    notify: host.notify,
    store: (videoId) => session(videoId).store,
    afterEdit,
    styleReference: assets.styleReference,
    onIdle: (videoId) => {
      if (closeAfterRun.delete(videoId)) void closeSession(videoId).catch(() => undefined);
    },
  });

  /** Videos with a render running, whose code the scene server serves even when they are closed. */
  const rendering = new Map<string, { blobs: BlobStore; holds: number }>();
  let runtimeVersion: Promise<string> | null = null;

  async function projectHosts(projectId: string | null): Promise<string[]> {
    if (!projectId) return [];
    return (await settingsStore.read()).projectSceneHosts[projectId] ?? [];
  }

  let captionTree: Promise<string> | null = null;
  /** The built-in caption page, stored once per run in the shared library like the style scenes. */
  function captionPageTree(): Promise<string> {
    captionTree ??= assets
      .captionPage()
      .then(async (files) => (await treeFromFiles(files, libraryBlobs)).treeHash);
    captionTree.catch(() => {
      captionTree = null;
    });
    return captionTree;
  }

  async function planInputs(store: VideoStore) {
    const media = new Map(
      store.mediaList().map((m) => [m.hash, { kind: m.kind, hasAudio: m.info.hasAudio }] as const),
    );
    return { media, captionTree: await captionPageTree() };
  }

  const render = createStudioRender({
    host: host.render,
    dataDir: host.dataDir,
    now,
    newId,
    notify: host.notify,
    async video(videoId) {
      const found = await entry(videoId);
      return { folder: found.folder, title: found.title };
    },
    async cache() {
      const file = await settingsStore.read();
      return { dir: file.cacheDir ?? host.defaultCacheDir, capBytes: file.cacheCapGb * 1024 ** 3 };
    },
    async autoResume() {
      return (await settingsStore.read()).autoResumeRenders;
    },
    serveTrees(videoId, folder) {
      const held = rendering.get(videoId) ?? { blobs: BlobStore.forVideo(folder), holds: 0 };
      held.holds += 1;
      rendering.set(videoId, held);
      return () => {
        held.holds -= 1;
        if (held.holds === 0) rendering.delete(videoId);
      };
    },
    runtimeVersion() {
      // The runtime bundle and the fonts are what a scene's pixels depend on besides its own code.
      runtimeVersion ??= Promise.all(
        [assets.runtimeFile, join(assets.root, 'assets', 'fonts', 'fonts.css')].map((file) =>
          readFile(file).catch(() => Buffer.from('missing')),
        ),
      ).then((files) => {
        const hash = createHash('sha256');
        for (const file of files) hash.update(file);
        return hash.digest('hex').slice(0, 16);
      });
      return runtimeVersion;
    },
    // A quarter of the memory, at most 3 GB, for the scene windows of one render.
    memoryCapBytes: Math.min(totalmem() / 4, 3 * 1024 ** 3),
  });

  /** ffmpeg and ffprobe, when both are installed: media and narration need them. */
  async function ffmpegTools() {
    const found = host.render ? await host.render.tools() : null;
    return found?.ffmpeg && found.ffprobe ? { ffmpeg: found.ffmpeg, ffprobe: found.ffprobe } : null;
  }

  const media = createMediaLibrary({
    tools: ffmpegTools,
    async cacheDir(videoId) {
      const file = await settingsStore.read();
      return join(file.cacheDir ?? host.defaultCacheDir, videoId, 'media');
    },
    notify: host.notify,
    now,
  });

  const voiceProfiles = new VoiceProfiles(join(host.dataDir, 'voices'), now, newId);
  const voiceKeys = createVoiceKeys(host.voice, () => voiceProfiles.list());
  const narrationCache = async (videoId: string) => {
    const file = await settingsStore.read();
    return join(file.cacheDir ?? host.defaultCacheDir, videoId, 'voice');
  };
  const localVoices = createLocalVoices({
    host: host.voice,
    profiles: voiceProfiles,
    workDir: async () =>
      join((await settingsStore.read()).cacheDir ?? host.defaultCacheDir, 'voice'),
    assetsRoot: assets.root,
    tools: ffmpegTools,
    newId,
  });

  function profileView(profile: VoiceProfile): VoiceProfileView {
    return {
      id: profile.id,
      name: profile.name,
      lang: profile.lang,
      seconds: profile.seconds,
      transcript: profile.transcript,
      createdAt: profile.createdAt,
      consentAt: profile.consent.at,
      elevenlabsVoiceId: profile.bindings.elevenlabs ?? null,
    };
  }

  async function requireProfile(profileId: string): Promise<VoiceProfile> {
    const profile = await voiceProfiles.get(profileId);
    if (!profile) throw new Error('That voice profile is not there any more.');
    return profile;
  }

  async function elevenLabsKey(): Promise<string> {
    const key = (await voiceKeys.keys()).elevenlabs;
    if (!key) throw new Error('Add an ElevenLabs key in Settings > Studio first.');
    return key;
  }
  const narrator = createNarrator({
    tools: ffmpegTools,
    keys: () => voiceKeys.keys(),
    fetch: host.voice?.fetch ?? fetch,
    baseUrl: host.voice?.baseUrl,
    cacheDir: narrationCache,
    store: (videoId) => session(videoId).store,
    afterEdit,
    notify: host.notify,
    newId,
    now,
    local: () => localVoices.speakers(),
  });

  const gen = createGenJobs({
    dataDir: host.dataDir,
    keys: async () => (await host.voice?.appKeys()) ?? {},
    fetch: host.voice?.fetch ?? fetch,
    baseUrl: host.voice?.baseUrl,
    async cacheDir(videoId) {
      const file = await settingsStore.read();
      return join(file.cacheDir ?? host.defaultCacheDir, videoId);
    },
    async importFile(videoId, file) {
      const open = sessions.get(videoId);
      if (!open) return null;
      const result = await media.importFiles(videoId, open.store, [file]);
      const made = result.imported[0];
      if (!made) throw new Error(result.skipped[0]?.reason ?? 'Studio could not take that file.');
      return { hash: made.hash, name: made.name };
    },
    notify: host.notify,
    newId,
    now,
  });

  async function createVideo(input: CreateVideoInput): Promise<VideoSummary> {
    let root: string;
    let projectFolder: string | null = null;
    if (input.projectId) {
      const resolved = await projectRoot(input.projectId);
      root = resolved.root;
      projectFolder = resolved.project.folderPath;
    } else {
      root = view(await settingsStore.read()).standaloneRoot;
    }
    const result = await check(root, projectFolder);
    if (!result.ok) throw new Error(firstError(result));
    const { folder, manifest } = await createVideoFolder(
      root,
      {
        id: newId(),
        title: input.title,
        language: input.language,
        aspect: input.aspect,
        linkedProjectId: input.projectId,
      },
      storeDeps(root),
    );
    const value: RegistryEntry = {
      id: manifest.id,
      title: manifest.title,
      folder,
      linkedProjectId: manifest.linkedProjectId,
      createdAt: manifest.createdAt,
      lastOpenedAt: null,
    };
    await putEntry(value);
    return summarize(value);
  }

  async function closeSession(videoId: string): Promise<void> {
    const open = sessions.get(videoId);
    if (!open) return;
    // The AI run writes its outcome into the video's history, so it stops before the video closes;
    // so does a narration run, which keeps the pieces it spoke for next time.
    await ai.stopForClose(videoId);
    const speaking = narrator.jobs(videoId).find((job) => job.status === 'running');
    if (speaking) {
      narrator.cancel(videoId, speaking.id);
      await narrator.idle(videoId);
    }
    sessions.delete(videoId);
    try {
      await open.store.close();
    } finally {
      await open.lock.release();
    }
  }

  return {
    async settings() {
      return view(await settingsStore.read());
    },

    async updateSettings(patch) {
      for (const key of ['defaultRoot', 'cacheDir'] as const) {
        const value = patch[key];
        if (value) {
          const result = await check(value, null);
          if (!result.ok) throw new Error(firstError(result));
        }
      }
      return view(await settingsStore.mutate((file) => Object.assign(file, patch)));
    },

    projectStorage: ({ projectId }) => storageView(projectId),

    async setProjectRoot({ projectId, path }) {
      const project = await requireProject(projectId);
      if (path !== null) {
        const result = await check(path, project.folderPath);
        if (!result.ok) throw new Error(firstError(result));
      }
      await settingsStore.mutate((file) => {
        if (path === null) delete file.projectRoots[projectId];
        else file.projectRoots[projectId] = path;
      });
      return storageView(projectId);
    },

    async setSceneHosts({ projectId, hosts }) {
      await requireProject(projectId);
      const unique = [...new Set(hosts)];
      await settingsStore.mutate((file) => {
        if (unique.length === 0) delete file.projectSceneHosts[projectId];
        else file.projectSceneHosts[projectId] = unique;
      });
      return storageView(projectId);
    },

    async sceneHosts({ treeHash }) {
      for (const open of sessions.values()) {
        if (!(await open.store.blobs.has(treeHash))) continue;
        const projectId = open.store.manifest.linkedProjectId;
        if (!projectId) return [];
        return (await settingsStore.read()).projectSceneHosts[projectId] ?? [];
      }
      return [];
    },

    async checkRoot({ path, projectId }) {
      return check(path, projectId ? (await requireProject(projectId)).folderPath : null);
    },

    async pruneProjects(known) {
      await settingsStore.mutate((file) => {
        for (const id of Object.keys(file.projectRoots))
          if (!known.has(id)) delete file.projectRoots[id];
        for (const id of Object.keys(file.projectSceneHosts))
          if (!known.has(id)) delete file.projectSceneHosts[id];
      });
    },

    async list(input) {
      const all = Object.values((await registry.read()).videos);
      const wanted =
        input?.projectId === undefined
          ? all
          : all.filter((v) => v.linkedProjectId === input.projectId);
      const sorted = wanted.sort((a, b) => b.createdAt - a.createdAt);
      return Promise.all(sorted.map(summarize));
    },

    create: createVideo,

    async backupData() {
      return { settings: await settingsStore.read(), recipes: await recipeStore.backup() };
    },

    checkBackup(data) {
      if (data.settings !== undefined && !settingsSchema.safeParse(data.settings).success) {
        return "The backup's Studio settings could not be read.";
      }
      return data.recipes === undefined ? null : RecipeStore.checkBackup(data.recipes);
    },

    async restoreBackup(data) {
      if (data.settings !== undefined) {
        const settings = settingsSchema.parse(data.settings);
        await settingsStore.mutate(() => settings);
      }
      if (data.recipes !== undefined) await recipeStore.restore(data.recipes);
    },

    async compareVersions({ videoId, from, to }) {
      const { store } = session(videoId);
      const names = new Map(store.mediaList().map((m) => [m.hash, m.name] as const));
      return compareDocuments(store.documentAt(from), store.documentAt(to), names);
    },

    async treeFiles({ videoId, treeHash }) {
      const { store } = session(videoId);
      const files = [];
      for (const file of (await readTree(store.blobs, treeHash)).files) {
        files.push({
          path: file.path,
          text: TEXT_FILE.test(file.path) ? await store.blobs.text(file.hash) : null,
        });
      }
      return files;
    },

    async branchVideo({ videoId, seq }) {
      const { store } = session(videoId);
      const document = store.documentAt(seq);
      const title = `${document.title} (from version ${seq})`.slice(0, 200);
      const made = await createVideo({
        title,
        projectId: store.manifest.linkedProjectId,
        language: document.language,
        aspect: document.renderSettings.aspect,
      });
      const target = await VideoStore.open(made.folder, storeDeps(made.folder));
      try {
        await seedBranch({ source: store, document, target, id: made.id, title });
      } finally {
        await target.close();
      }
      return summarize(await entry(made.id));
    },

    open: ({ videoId }) => openWith(videoId, false),
    takeOver: ({ videoId }) => openWith(videoId, true),
    async close({ videoId }) {
      // Leaving the editor does not stop a scenario being written: the video stays open until
      // the run ends, then closes. Quitting, moving or removing the video does stop it.
      if (ai.isRunning(videoId)) {
        closeAfterRun.add(videoId);
        return;
      }
      await closeSession(videoId);
    },

    async apply({ videoId, baseSeq, ops, label }) {
      const { store } = session(videoId);
      try {
        const result = store.apply({ baseSeq, ops, label });
        await afterEdit(videoId, store);
        return { ok: true, ...response(store, result.seq, result.document) };
      } catch (error) {
        if (!(error instanceof StaleEditError)) throw error;
        return { ok: false, reason: 'stale', ...response(store, store.seq, store.document) };
      }
    },

    async undo({ videoId }) {
      const { store } = session(videoId);
      const result = store.undo();
      if (!result) return null;
      await afterEdit(videoId, store);
      return response(store, result.seq, result.document);
    },

    async redo({ videoId }) {
      const { store } = session(videoId);
      const result = store.redo();
      if (!result) return null;
      await afterEdit(videoId, store);
      return response(store, result.seq, result.document);
    },

    async history({ videoId, before, limit }) {
      return session(videoId)
        .store.history({ before, limit })
        .map(({ of: _of, ...rest }) => rest);
    },

    async version({ videoId, seq }) {
      return session(videoId).store.documentAt(seq);
    },

    async restore({ videoId, seq }) {
      const { store } = session(videoId);
      const result = store.restore(seq);
      await afterEdit(videoId, store);
      return response(store, result.seq, result.document);
    },

    async addExisting({ folder }) {
      const manifest = await readVideoManifest(folder);
      const known = (await registry.read()).videos[manifest.id];
      const value: RegistryEntry = {
        id: manifest.id,
        title: manifest.title,
        folder,
        linkedProjectId: manifest.linkedProjectId,
        createdAt: manifest.createdAt,
        lastOpenedAt: known?.lastOpenedAt ?? null,
      };
      await putEntry(value);
      return summarize(value);
    },

    async locate({ videoId, folder }) {
      const found = await entry(videoId);
      const manifest = await readVideoManifest(folder);
      if (manifest.id !== videoId) throw new Error('That folder holds a different video.');
      const value = { ...found, folder, title: manifest.title };
      await putEntry(value);
      return summarize(value);
    },

    async removeFromLibrary({ videoId }) {
      await closeSession(videoId);
      await registry.mutate((file) => {
        delete file.videos[videoId];
      });
      host.notify({ type: 'library-changed' });
    },

    async move({ videoId, toRoot }) {
      const found = await entry(videoId);
      const projectFolder = found.linkedProjectId
        ? ((await host.projects.get(found.linkedProjectId))?.folderPath ?? null)
        : null;
      const result = await check(toRoot, projectFolder);
      if (!result.ok) throw new Error(firstError(result));
      if (await render.busy(videoId)) {
        throw new Error(
          'This video is rendering. Wait for the render to finish, or cancel it, then move it.',
        );
      }

      await closeSession(videoId);
      // Hold the old folder while copying, so no other copy of AgentMate opens it half-way.
      const locked = await acquireVideoLock(found.folder, lockOptions());
      if (!locked.ok)
        throw new Error('This video is open in another copy of AgentMate. Close it there first.');
      try {
        const target = join(toRoot, basename(found.folder));
        if (await exists(target)) throw new Error(`A folder named ${target} already exists.`);
        await mkdir(toRoot, { recursive: true });
        await cp(found.folder, target, {
          recursive: true,
          errorOnExist: true,
          force: false,
          filter: (source) => !skipOnCopy(basename(source)),
        });
        const [before, after] = await Promise.all([
          listFiles(found.folder, skipOnCopy),
          listFiles(target, skipOnCopy),
        ]);
        const same =
          before.size === after.size &&
          [...before].every(([file, size]) => after.get(file) === size);
        if (!same)
          throw new Error(
            'The copy did not come out the same as the original. The video was not moved.',
          );
        const value = { ...found, folder: target };
        await putEntry(value);
        return { video: await summarize(value), oldFolder: found.folder };
      } finally {
        await locked.lock.release();
      }
    },

    startScenario: (input) => ai.startScenario(input),
    startEdit: (input) => ai.startEdit(input),
    retryGeneration: (input) => ai.retry(input),
    cancelGeneration: (input) => ai.cancel(input),
    generations: async (input) => ai.generations(input),
    generationDetail: (input) => ai.detail(input),

    async applyProposal(input) {
      const { store } = session(input.videoId);
      const result = await ai.applyProposal(input);
      return response(store, result.seq, result.document);
    },

    discardProposal: (input) => ai.discardProposal(input),
    recipes: () => recipeStore.list(),
    saveRecipe: (input) => recipeStore.save(input),
    deleteRecipe: ({ recipeId }) => recipeStore.remove(recipeId),
    recipeVersions: ({ recipeId }) => recipeStore.versions(recipeId),
    recipeVersion: ({ recipeId, version }) => recipeStore.version(recipeId, version),
    exportRecipe: ({ recipeId }) => recipeStore.exportText(recipeId),
    importRecipe: ({ text }) => recipeStore.importText(text),

    libraryBlobs,
    assets,

    startScene: (input) => ai.startScene(input),

    styleReference: (input) => styleReference(input),

    async checkStyleReference(input) {
      if (!host.scenes) throw new Error('This copy of Studio cannot check scenes.');
      const reference = await styleReference(input);
      const size = DESIGN_SIZES[input.aspect];
      const result = await host.scenes.check({
        url: reference.url,
        width: size.width,
        height: size.height,
        duration: REFERENCE_SECONDS,
        fps: 30,
      });
      return { ok: result.ok, problems: result.problems, notes: result.notes };
    },

    async sceneCode({ videoId, sceneId }) {
      const { store } = session(videoId);
      const scene = sceneOf(store, sceneId);
      const treeHash = scene.code.treeHash;
      const files: SceneCodeView['files'] = [];
      if (treeHash) {
        for (const file of (await readTree(store.blobs, treeHash)).files) {
          const text = TEXT_FILE.test(file.path) ? await store.blobs.text(file.hash) : null;
          files.push({ path: file.path, size: file.size, text });
        }
      }
      const revisions = store
        .codeRevisions(sceneId)
        .slice(0, 100)
        .map(({ id, treeHash: hash, author, label, generationId, at }) => ({
          id,
          treeHash: hash,
          author,
          label,
          generationId,
          at,
        }));
      return { sceneId, treeHash, files, revisions };
    },

    async saveSceneFiles({ videoId, sceneId, files }) {
      const { store } = session(videoId);
      const scene = sceneOf(store, sceneId);
      const position = store.document.scenario.scenes.indexOf(scene) + 1;
      // Files the editor did not send (images, fonts) are carried over from the current tree.
      const kept: { path: string; content: Uint8Array }[] = [];
      if (scene.code.treeHash) {
        for (const file of (await readTree(store.blobs, scene.code.treeHash)).files) {
          if (!files.some((f) => f.path === file.path)) {
            kept.push({ path: file.path, content: await store.blobs.bytes(file.hash) });
          }
        }
      }
      const tree = await treeFromFiles([...kept, ...files], store.blobs);
      if (tree.skipped.length > 0) throw new Error(`Not saved: ${tree.skipped.join('; ')}`);
      const result = store.setSceneCode({
        sceneId,
        treeHash: tree.treeHash,
        author: 'user',
        label: `Edited the code of scene ${position}`,
      });
      await store.mirrorScene(sceneId);
      await afterEdit(videoId, store);
      return response(store, result.seq, result.document);
    },

    async useCodeRevision({ videoId, sceneId, revisionId }) {
      const { store } = session(videoId);
      const scene = sceneOf(store, sceneId);
      const revision = store.codeRevisions(sceneId).find((r) => r.id === revisionId);
      if (!revision) throw new Error('That version of the code is not in this video.');
      const position = store.document.scenario.scenes.indexOf(scene) + 1;
      const result = store.setSceneCode({
        sceneId,
        treeHash: revision.treeHash,
        author: 'user',
        label: `Went back to an earlier version of the code of scene ${position}`,
      });
      await store.mirrorScene(sceneId);
      await afterEdit(videoId, store);
      return response(store, result.seq, result.document);
    },

    async checkScene({ videoId, sceneId }) {
      if (!host.scenes) throw new Error('This copy of Studio cannot check scenes.');
      const { store } = session(videoId);
      const scene = sceneOf(store, sceneId);
      const treeHash = scene.code.treeHash;
      if (!treeHash) throw new Error('This scene has no code yet.');
      const doc = store.document;
      const size = DESIGN_SIZES[doc.renderSettings.aspect];
      const result = await host.scenes.check({
        url: sceneUrl(treeHash, sceneConfig(doc, scene)),
        width: size.width,
        height: size.height,
        duration: flicksToSeconds(scene.targetDuration),
        fps: doc.renderSettings.fps,
      });
      if (result.thumbnailPng) {
        store.setThumbnail(treeHash, await store.blobs.put(result.thumbnailPng));
      }
      return { ok: result.ok, problems: result.problems, notes: result.notes };
    },

    async thumbnail({ videoId, treeHash }) {
      const { store } = session(videoId);
      const png = store.thumbnail(treeHash);
      return png ? store.blobs.bytes(png) : null;
    },

    async sceneFile({ treeHash, path }) {
      const stores = [
        ...[...sessions.values()].map((s) => s.store.blobs),
        ...[...rendering.values()].map((r) => r.blobs),
        libraryBlobs,
      ];
      for (const blobs of stores) {
        if (!(await blobs.has(treeHash))) continue;
        let manifest = manifests.get(treeHash);
        if (!manifest) {
          manifest = await readTree(blobs, treeHash);
          manifests.set(treeHash, manifest);
        }
        const file = treeFile(manifest, path);
        return file ? blobs.bytes(file.hash) : null;
      }
      return null;
    },

    async importMedia({ videoId, paths }) {
      return media.importFiles(videoId, session(videoId).store, paths);
    },

    async media({ videoId }) {
      return media.list(videoId, session(videoId).store);
    },

    async mediaFile({ videoId, hash, variant }) {
      const open = sessions.get(videoId);
      return open ? media.file(videoId, open.store, hash, variant) : null;
    },

    async voiceEngines() {
      return voiceKeys.engines();
    },

    async voices(input) {
      return voiceKeys.voices(input);
    },

    async setVoiceKey(input) {
      await voiceKeys.setKey(input);
      return voiceKeys.engines();
    },

    async speak(input) {
      session(input.videoId);
      return narrator.speak(input);
    },

    async narrationJobs({ videoId }) {
      return narrator.jobs(videoId);
    },

    async cancelNarration({ videoId, jobId }) {
      narrator.cancel(videoId, jobId);
    },

    async recordNarration({ videoId, sceneId, bytes, mimeType }) {
      const { store } = session(videoId);
      const dir = join(await narrationCache(videoId), 'recordings');
      await mkdir(dir, { recursive: true });
      const file = join(dir, `${newId()}.${mimeType.includes('wav') ? 'wav' : 'webm'}`);
      await writeFile(file, bytes);
      try {
        const document = await narrator.placeRecording({ videoId, sceneId, file });
        return response(store, store.seq, document);
      } finally {
        await rm(file, { force: true });
      }
    },

    async captionScene({ videoId, sceneId }) {
      const { store } = session(videoId);
      const document = await narrator.captionScene({ videoId, sceneId });
      return response(store, store.seq, document);
    },

    async voiceProfiles() {
      return (await voiceProfiles.list()).map(profileView);
    },

    async transcribeTake({ bytes, mimeType, lang }) {
      const take = await localVoices.prepareTake(bytes, mimeType);
      try {
        const text = (await host.voice?.transcribe?.({ wav: take.wav, lang })) ?? null;
        return { text: text?.trim() ?? '', seconds: take.seconds };
      } finally {
        await rm(take.wav, { force: true });
      }
    },

    async createVoiceProfile({ bytes, mimeType, name, lang, transcript, consent }) {
      const take = await localVoices.prepareTake(bytes, mimeType);
      try {
        const profile = await voiceProfiles.create({
          name,
          lang,
          wav: take.wav,
          seconds: take.seconds,
          transcript,
          consent,
        });
        return profileView(profile);
      } finally {
        await rm(take.wav, { force: true });
      }
    },

    async updateVoiceProfile({ profileId, name, transcript }) {
      return profileView(await voiceProfiles.update(profileId, { name, transcript }));
    },

    async cloneVoiceProfile({ profileId, acknowledgeUpload }) {
      const profile = await requireProfile(profileId);
      if (acknowledgeUpload !== true) {
        throw new Error('Confirm that the recording may be uploaded to ElevenLabs.');
      }
      if (!profile.consent?.at) {
        throw new Error('This voice profile has no consent recorded, so it cannot be cloned.');
      }
      if (profile.bindings.elevenlabs) return profileView(profile);
      const voiceId = await cloneElevenLabsVoice({
        key: await elevenLabsKey(),
        name: profile.name,
        wav: new Uint8Array(await readFile(voiceProfiles.recording(profile.id))),
        fetch: host.voice?.fetch ?? fetch,
        baseUrl: host.voice?.baseUrl,
      });
      return profileView(await voiceProfiles.update(profile.id, { elevenlabs: voiceId }));
    },

    async removeVoiceProfile({ profileId }) {
      const profile = await requireProfile(profileId);
      // The copy in ElevenLabs goes first; if it cannot, the profile stays so nothing is orphaned.
      if (profile.bindings.elevenlabs) {
        await deleteElevenLabsVoice({
          key: await elevenLabsKey(),
          voiceId: profile.bindings.elevenlabs,
          fetch: host.voice?.fetch ?? fetch,
          baseUrl: host.voice?.baseUrl,
        });
      }
      await voiceProfiles.remove(profile.id);
    },

    async renderTools() {
      return render.tools();
    },

    async renderEstimate({ videoId }) {
      const { store } = session(videoId);
      return render.estimate({
        videoId,
        document: store.document,
        planInputs: await planInputs(store),
      });
    },

    async startRender({ videoId, fileName }) {
      const { store } = session(videoId);
      // The setting in Settings turns graphics card encoding off for every video.
      const allowGpu = (await settingsStore.read()).hwEncode;
      const document = structuredClone(store.document);
      document.renderSettings.hwEncode &&= allowGpu;
      return render.start({
        videoId,
        document,
        allowedHosts: await projectHosts(store.manifest.linkedProjectId),
        fileName,
        planInputs: await planInputs(store),
      });
    },

    async renderJobs({ videoId }) {
      return render.jobs(videoId);
    },

    async cancelRender({ jobId }) {
      await render.cancel(jobId);
    },

    async retryRender({ jobId }) {
      return render.retry(jobId);
    },

    async removeRender({ jobId }) {
      await render.remove(jobId);
    },

    async genEstimate(input) {
      return gen.estimate(input);
    },

    async startGen(input) {
      session(input.videoId);
      return gen.start(input);
    },

    async genJobs({ videoId }) {
      return gen.jobs(videoId);
    },

    async cancelGen({ jobId }) {
      await gen.cancel(jobId);
    },

    async resumeRenders() {
      await gen.resumeAfterStart();
      await render.resumeAfterStart();
    },

    async shutdown() {
      await gen.shutdown();
      await narrator.shutdown();
      await localVoices.stop();
      await media.shutdown();
      await render.shutdown();
      await ai.shutdown();
      await Promise.all([...sessions.keys()].map(closeSession));
    },

    abandonForTest(videoId) {
      const open = sessions.get(videoId);
      if (!open) return;
      ai.abandonForTest(videoId);
      sessions.delete(videoId);
      open.store.crashForTest();
      open.lock.abandon();
    },
  };
}
