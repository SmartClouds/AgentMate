import { access, cp, mkdir, readdir, stat } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { basename, join, relative } from 'node:path';
import { z } from 'zod';
import type {
  ApplyResult,
  CreateVideoInput,
  EditResponse,
  GenerationDetail,
  GenerationView,
  HistoryEntryView,
  MoveResult,
  OpenVideoResult,
  ProjectStorageView,
  RecipeView,
  RootCheckView,
  SaveRecipeInput,
  StartEditInput,
  StartScenarioInput,
  StudioEvent,
  StudioSettingsPatch,
  StudioSettingsView,
  VideoSession,
  VideoSummary,
} from '../api.js';
import type { EditOp } from '../document/ops.js';
import type { StudioDocument } from '../document/schema.js';
import { newId, safeFolderName } from '../text/names.js';
import { createStudioAi, type StudioAiHost } from './ai/studioAi.js';
import type { OpenSqlDriver } from './db/sqlDriver.js';
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
import { JsonStore } from './settings/jsonStore.js';

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

export interface StudioService {
  settings(): Promise<StudioSettingsView>;
  updateSettings(patch: StudioSettingsPatch): Promise<StudioSettingsView>;
  projectStorage(input: { projectId: string }): Promise<ProjectStorageView>;
  setProjectRoot(input: { projectId: string; path: string | null }): Promise<ProjectStorageView>;
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
    return { projectId, root, isCustom, check: await check(root, project.folderPath) };
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
    await putEntry({ ...found, title: store.manifest.title, lastOpenedAt: now() });
    return { state: 'open', session: await sessionView(videoId, store) };
  }

  const ai = createStudioAi({
    ai: host.ai,
    now,
    newId,
    notify: host.notify,
    store: (videoId) => session(videoId).store,
    afterEdit,
    onIdle: (videoId) => {
      if (closeAfterRun.delete(videoId)) void closeSession(videoId).catch(() => undefined);
    },
  });

  async function closeSession(videoId: string): Promise<void> {
    const open = sessions.get(videoId);
    if (!open) return;
    // The AI run writes its outcome into the video's history, so it stops before the video closes.
    await ai.stopForClose(videoId);
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

    async checkRoot({ path, projectId }) {
      return check(path, projectId ? (await requireProject(projectId)).folderPath : null);
    },

    async pruneProjects(known) {
      await settingsStore.mutate((file) => {
        for (const id of Object.keys(file.projectRoots))
          if (!known.has(id)) delete file.projectRoots[id];
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

    async create(input) {
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

    async shutdown() {
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
