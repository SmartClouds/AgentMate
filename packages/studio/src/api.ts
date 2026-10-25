import { z } from 'zod';
import { editOpSchema } from './document/ops.js';
import { ASPECTS, type StudioDocument } from './document/schema.js';
import { isContentLanguage } from './text/languages.js';

/**
 * The contract between Studio's UI and its service. The desktop app carries it over IPC; another
 * host (Studio as its own app) would carry the same calls its own way. Inputs are checked with
 * these schemas on the service side, since the UI is not trusted to send only what it should.
 */

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const folderPath = z.string().min(1).max(4096);
const projectId = z.string().min(1).max(200);

export const studioInputs = {
  videoRef: z.object({ videoId: id }),
  projectRef: z.object({ projectId }),
  list: z.object({ projectId: projectId.nullable().optional() }).optional(),
  create: z.object({
    title: z.string().trim().min(1).max(200),
    projectId: projectId.nullable(),
    language: z.string().refine(isContentLanguage, 'Pick one of the offered languages.'),
    aspect: z.enum(ASPECTS),
  }),
  checkRoot: z.object({ path: folderPath, projectId: projectId.nullable() }),
  setProjectRoot: z.object({ projectId, path: folderPath.nullable() }),
  updateSettings: z
    .object({
      defaultRoot: folderPath.nullable(),
      cacheDir: folderPath.nullable(),
      cacheCapGb: z.number().int().min(1).max(2000),
      autoResumeRenders: z.boolean(),
      hwEncode: z.boolean(),
    })
    .partial()
    .strict(),
  apply: z.object({
    videoId: id,
    baseSeq: z.number().int().nonnegative(),
    ops: z.array(editOpSchema).min(1).max(1000),
    label: z.string().trim().min(1).max(300),
  }),
  history: z.object({
    videoId: id,
    before: z.number().int().positive().optional(),
    limit: z.number().int().min(1).max(500),
  }),
  version: z.object({ videoId: id, seq: z.number().int().positive() }),
  folder: z.object({ folder: folderPath }),
  locate: z.object({ videoId: id, folder: folderPath }),
  move: z.object({ videoId: id, toRoot: folderPath }),
};

export type CreateVideoInput = z.infer<typeof studioInputs.create>;
export type StudioSettingsPatch = z.infer<typeof studioInputs.updateSettings>;

export interface StudioSettingsView {
  /** Where standalone videos go, and the base for projects without a folder of their own. */
  defaultRoot: string;
  defaultRootIsCustom: boolean;
  /** Where videos that belong to no project are made. */
  standaloneRoot: string;
  cacheDir: string;
  cacheCapGb: number;
  autoResumeRenders: boolean;
  hwEncode: boolean;
}

export interface VideoSummary {
  id: string;
  title: string;
  folder: string;
  linkedProjectId: string | null;
  createdAt: number;
  lastOpenedAt: number | null;
  /** The folder is gone (moved, renamed or deleted outside AgentMate); Locate finds it again. */
  missing: boolean;
}

export interface RootProblemView {
  code: string;
  level: 'error' | 'warning';
  message: string;
}

export interface RootCheckView {
  ok: boolean;
  resolved: string;
  problems: RootProblemView[];
}

export interface ProjectStorageView {
  projectId: string;
  root: string;
  /** False while the project uses the default folder under the Studio library. */
  isCustom: boolean;
  check: RootCheckView;
}

export interface VideoStatusView {
  seq: number;
  canUndo: boolean;
  canRedo: boolean;
  undoLabel: string | null;
  redoLabel: string | null;
}

export interface VideoSession {
  video: VideoSummary;
  document: StudioDocument;
  status: VideoStatusView;
}

export interface LockHolderView {
  appId: string;
  host: string;
  pid: number;
  heartbeatAt: number;
}

export type OpenVideoResult =
  | { state: 'open'; session: VideoSession }
  | { state: 'locked'; holder: LockHolderView; stale: boolean }
  | { state: 'missing'; video: VideoSummary }
  | { state: 'error'; message: string };

export type ApplyResult =
  | { ok: true; seq: number; document: StudioDocument; status: VideoStatusView }
  /** The video moved on (an AI edit landed first); this is where it stands now. */
  | { ok: false; reason: 'stale'; seq: number; document: StudioDocument; status: VideoStatusView };

export interface EditResponse {
  seq: number;
  document: StudioDocument;
  status: VideoStatusView;
}

export interface HistoryEntryView {
  seq: number;
  at: number;
  kind: 'edit' | 'undo' | 'redo' | 'mark';
  actor: 'user' | 'ai' | 'system';
  label: string;
  generationId: string | null;
  opCount: number;
}

export interface MoveResult {
  video: VideoSummary;
  /** The old copy, left in place so the UI can offer to put it in the trash. */
  oldFolder: string;
}

export type StudioEvent =
  | { type: 'library-changed' }
  | { type: 'video-changed'; videoId: string; seq: number };
