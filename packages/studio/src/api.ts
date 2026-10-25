import type { EffortLevel } from '@agentmat/core';
import { z } from 'zod';
import type { EditProposal } from './ai/edit/answer.js';
import { editOpSchema } from './document/ops.js';
import { ASPECTS, type Aspect, type StudioDocument } from './document/schema.js';
import { styleById } from './styles/presets.js';
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
  setSceneHosts: z.object({
    projectId,
    /** Host names only, like cdn.example.com; scenes may load from them over https. */
    hosts: z
      .array(
        z
          .string()
          .trim()
          .toLowerCase()
          .regex(
            /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,63}$/,
            'Enter a host name such as cdn.example.com.',
          ),
      )
      .max(20),
  }),
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

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[];

/** The CLI, model and effort for one AI run. No CLI means the app's default CLI. */
export const runSettingsSchema = z.object({
  cliId: z.string().min(1).max(64).nullable(),
  model: z.string().trim().min(1).max(200).nullable().optional(),
  effort: z.enum(EFFORT_LEVELS).nullable().optional(),
});
export type RunSettingsInput = z.infer<typeof runSettingsSchema>;

const styleId = z
  .string()
  .max(64)
  .refine((value) => styleById(value) !== undefined, 'Pick one of the offered styles.')
  .nullable();
const targetSeconds = z.number().int().min(5).max(1800);
const brief = z.string().trim().min(1).max(100_000);

export const studioAiInputs = {
  startScenario: z.object({ videoId: id, brief, targetSeconds, styleId, run: runSettingsSchema }),
  startEdit: z.object({
    videoId: id,
    instruction: z.string().trim().min(1).max(20_000),
    run: runSettingsSchema,
  }),
  startScene: z.object({
    videoId: id,
    sceneId: id,
    /** What to change; without it the scene is animated from scratch. */
    instruction: z.string().trim().min(1).max(20_000).optional(),
    run: runSettingsSchema,
  }),
  generationRef: z.object({ videoId: id, generationId: id }),
  generations: z.object({ videoId: id, limit: z.number().int().min(1).max(500) }),
  saveRecipe: z.object({
    id: id.optional(),
    name: z.string().trim().min(1).max(120),
    brief,
    styleId,
    language: z.string().refine(isContentLanguage, 'Pick one of the offered languages.'),
    aspect: z.enum(ASPECTS),
    targetSeconds,
    scenario: runSettingsSchema,
  }),
  recipeRef: z.object({ recipeId: id }),
  sceneRef: z.object({ videoId: id, sceneId: id }),
  saveSceneFiles: z.object({
    videoId: id,
    sceneId: id,
    files: z
      .array(z.object({ path: z.string().min(1).max(300), content: z.string().max(5_000_000) }))
      .min(1)
      .max(50),
  }),
  useCodeRevision: z.object({ videoId: id, sceneId: id, revisionId: z.number().int().positive() }),
  thumbnail: z.object({ videoId: id, treeHash: z.string().regex(/^[0-9a-f]{64}$/) }),
  styleReference: z.object({
    styleId: z
      .string()
      .max(64)
      .refine((value) => styleById(value) !== undefined, 'Pick one of the offered styles.'),
    aspect: z.enum(ASPECTS),
    language: z.string().refine(isContentLanguage, 'Pick one of the offered languages.'),
  }),
};

/** A style's reference scene, ready to preview: its tree and the config to load it with. */
export interface StyleReferenceView {
  styleId: string;
  treeHash: string;
  url: string;
}

export type SaveSceneFilesInput = z.infer<typeof studioAiInputs.saveSceneFiles>;

export interface CodeRevisionView {
  id: number;
  treeHash: string;
  author: 'ai' | 'user';
  label: string;
  generationId: string | null;
  at: number;
}

export interface SceneCodeView {
  sceneId: string;
  treeHash: string | null;
  /** Text files carry their content; other files (images, fonts) only their size. */
  files: { path: string; size: number; text: string | null }[];
  revisions: CodeRevisionView[];
}

export interface SceneCheckView {
  ok: boolean;
  problems: string[];
  notes: string[];
}

export type StartScenarioInput = z.infer<typeof studioAiInputs.startScenario>;
export type StartEditInput = z.infer<typeof studioAiInputs.startEdit>;
export type StartSceneInput = z.infer<typeof studioAiInputs.startScene>;
export type SaveRecipeInput = z.infer<typeof studioAiInputs.saveRecipe>;

/** A saved way of making a video: the brief, the look, the format and the AI picks per stage. */
export interface RecipeView {
  id: string;
  name: string;
  brief: string;
  styleId: string | null;
  language: string;
  aspect: Aspect;
  targetSeconds: number;
  scenario: RunSettingsInput;
  createdAt: number;
  updatedAt: number;
}

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
  /** Hosts this project's scenes may load from; empty means no network at all. */
  sceneHosts: string[];
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

export type GenerationStage = 'scenario' | 'edit' | 'scene';

export type GenerationStatus =
  | 'running'
  /** A scenario that was written into the video. */
  | 'done'
  /** An edit waiting for the user to apply or discard it. */
  | 'proposed'
  | 'applied'
  | 'discarded'
  | 'failed'
  | 'cancelled'
  /** The app closed or crashed while it ran. CLI runs cannot resume, so it can only be retried. */
  | 'interrupted';

/** One CLI run inside a generation: the first try, then each repair round. */
export interface GenerationAttempt {
  requestHash: string;
  outputHash: string | null;
  logHash: string | null;
  startedAt: number;
  finishedAt: number | null;
  /** What was wrong with the answer, sent back in the next repair round. */
  issues: string[];
  error: string | null;
}

/** An edit proposal as stored: the ops were checked against the video at `baseSeq`. */
export type StoredProposal = EditProposal & { baseSeq: number };

export interface GenerationParams {
  targetSeconds?: number;
  styleId?: string | null;
  /** The scene a scene run writes the code of. */
  sceneId?: string;
}

export interface GenerationView {
  id: string;
  parentId: string | null;
  stage: GenerationStage;
  status: GenerationStatus;
  cliId: string | null;
  /** The CLI that really answered, which differs from `cliId` when none was picked. */
  cliName: string | null;
  model: string | null;
  effort: EffortLevel | null;
  /** The user's own words: the brief, or what to change. */
  instruction: string;
  params: GenerationParams;
  attempts: GenerationAttempt[];
  proposal: StoredProposal | null;
  /** The history entry this generation made. */
  resultSeq: number | null;
  error: string | null;
  startedAt: number;
  finishedAt: number | null;
}

/** A generation with what was sent and what came back in each attempt, for the details view. */
export interface GenerationDetail extends GenerationView {
  texts: { request: string; output: string | null; log: string | null }[];
}

export type StudioEvent =
  | { type: 'library-changed' }
  | { type: 'video-changed'; videoId: string; seq: number }
  | { type: 'generation-changed'; videoId: string; generationId: string }
  /** New lines of a running CLI's output, batched. */
  | { type: 'generation-output'; videoId: string; generationId: string; lines: string[] };
