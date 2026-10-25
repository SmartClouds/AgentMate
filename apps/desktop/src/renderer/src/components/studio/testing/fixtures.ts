import {
  createDocument,
  createScene,
  type OpenVideoResult,
  type ProjectStorageView,
  type RootCheckView,
  type StudioDocument,
  type StudioSettingsView,
  type VideoStatusView,
  type VideoSummary,
} from '@agentmat/studio';

/** Builders for Studio's renderer tests, so each test spells out only what it is about. */

export const NOW = Date.now();

export function video(overrides: Partial<VideoSummary> = {}): VideoSummary {
  return {
    id: 'v1aaaaaaaaaaaaaa',
    title: 'Launch film',
    folder: 'C:\\Users\\me\\Videos\\AgentMate Studio\\Standalone\\Launch-film-v1aaaaaa',
    linkedProjectId: null,
    createdAt: NOW - 3 * 3600_000,
    lastOpenedAt: null,
    missing: false,
    ...overrides,
  };
}

export function status(overrides: Partial<VideoStatusView> = {}): VideoStatusView {
  return { seq: 1, canUndo: false, canRedo: false, undoLabel: null, redoLabel: null, ...overrides };
}

export function document(overrides: Partial<StudioDocument> = {}): StudioDocument {
  return {
    ...createDocument({ id: 'v1aaaaaaaaaaaaaa', title: 'Launch film', language: 'fa' }),
    ...overrides,
  };
}

export function withScenes(...titles: string[]): StudioDocument {
  const d = document();
  d.scenario.scenes = titles.map((title, i) => createScene({ id: `s${i + 1}`, title }));
  return d;
}

export function opened(
  doc: StudioDocument = document(),
  st: VideoStatusView = status(),
): OpenVideoResult {
  return { state: 'open', session: { video: video(), document: doc, status: st } };
}

export function ok(problems: RootCheckView['problems'] = []): RootCheckView {
  return { ok: !problems.some((p) => p.level === 'error'), resolved: 'D:\\Videos', problems };
}

export const INSIDE_PROJECT: RootCheckView['problems'][number] = {
  code: 'inside-project',
  level: 'error',
  message: "Videos can't be stored inside the project's folder.",
};

export function settings(overrides: Partial<StudioSettingsView> = {}): StudioSettingsView {
  return {
    defaultRoot: 'C:\\Users\\me\\Videos\\AgentMate Studio',
    defaultRootIsCustom: false,
    standaloneRoot: 'C:\\Users\\me\\Videos\\AgentMate Studio\\Standalone',
    cacheDir: 'C:\\Users\\me\\AppData\\Roaming\\AgentMate\\studio-cache',
    cacheCapGb: 20,
    autoResumeRenders: true,
    hwEncode: true,
    ...overrides,
  };
}

export function storage(overrides: Partial<ProjectStorageView> = {}): ProjectStorageView {
  return {
    projectId: 'p1',
    root: 'C:\\Users\\me\\Videos\\AgentMate Studio\\Projects\\Shop',
    isCustom: false,
    check: ok(),
    ...overrides,
  };
}

export const PROJECT = { id: 'p1', name: 'Shop', folderPath: 'C:\\code\\shop', archived: false };
