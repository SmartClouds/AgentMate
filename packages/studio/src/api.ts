import type { EffortLevel } from '@agentmat/core';
import { z } from 'zod';
import type { EditProposal } from './ai/edit/answer.js';
import { editOpSchema } from './document/ops.js';
import {
  ASPECTS,
  type Aspect,
  type Codec,
  type RenderSettings,
  type StudioDocument,
} from './document/schema.js';
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

export const MEDIA_VARIANTS = ['original', 'proxy', 'poster', 'sprite', 'peaks'] as const;
export type MediaVariant = (typeof MEDIA_VARIANTS)[number];

export const studioMediaInputs = {
  importFiles: z.object({
    videoId: id,
    paths: z.array(z.string().min(1).max(4096)).min(1).max(100),
  }),
  videoRef: z.object({ videoId: id }),
  mediaRef: z.object({ videoId: id, hash: z.string().regex(/^[0-9a-f]{64}$/) }),
};

/** A file imported into a video, with what the editor can show of it so far. */
export interface MediaView {
  hash: string;
  name: string;
  kind: 'video' | 'audio' | 'image';
  /** Flicks; null for a still image. */
  duration: number | null;
  width: number | null;
  height: number | null;
  fps: number | null;
  hasAudio: boolean;
  bytes: number;
  importedAt: number;
  /** The preview files made so far. */
  ready: Record<Exclude<MediaVariant, 'original'>, boolean>;
  /** Still making preview files. */
  preparing: boolean;
  /** Why a preview file could not be made, if one could not. The file still renders. */
  problem: string | null;
}

export interface ImportResult {
  imported: MediaView[];
  /** Files that were not imported, with why. */
  skipped: { path: string; reason: string }[];
}

const recording = {
  /** The recording as the browser made it (WebM with Opus, usually). */
  bytes: z
    .instanceof(Uint8Array)
    .refine(
      (b) => b.length > 0 && b.length <= 200 * 1024 * 1024,
      'The recording is empty or too long.',
    ),
  mimeType: z.string().max(100),
};

const voiceRef = z
  .string()
  .max(200)
  .regex(
    /^(openai|gemini|elevenlabs|azure|piper|omnivoice):[A-Za-z0-9_.-]{1,100}$/,
    'Pick one of the offered voices.',
  );

export const studioAudioInputs = {
  speak: z.object({ videoId: id, sceneIds: z.array(id).min(1).max(500), voiceRef }),
  jobs: z.object({ videoId: id }),
  jobRef: z.object({ videoId: id, jobId: id }),
  voices: z.object({
    engine: z.enum(['openai', 'gemini', 'elevenlabs', 'azure', 'piper', 'omnivoice']),
    lang: z.string().min(2).max(35),
  }),
  record: z.object({ videoId: id, sceneId: id, ...recording }),
  /** What a take for a voice profile says, by speech recognition, before the profile is made. */
  transcribeTake: z.object({ ...recording, lang: z.string().min(2).max(35) }),
  createProfile: z.object({
    ...recording,
    name: z.string().trim().min(1).max(80),
    lang: z.string().min(2).max(35),
    transcript: z.string().max(5000),
    consent: z.literal(true, {
      error: 'Confirm that this is your voice, or that you have permission to use it.',
    }),
  }),
  profileRef: z.object({ profileId: id }),
  updateProfile: z.object({
    profileId: id,
    name: z.string().trim().min(1).max(80).optional(),
    transcript: z.string().max(5000).optional(),
  }),
  /** Uploads the profile's recording to the person's ElevenLabs account, once they agreed to it. */
  cloneProfile: z.object({ profileId: id, acknowledgeUpload: z.literal(true) }),
  captionScene: z.object({ videoId: id, sceneId: id }),
  setKey: z.object({
    engine: z.enum(['elevenlabs', 'azure']),
    key: z.string().trim().max(500).nullable(),
    region: z
      .string()
      .trim()
      .regex(/^[a-z0-9]{2,40}$/, 'That is not an Azure region, such as westeurope.')
      .optional(),
  }),
};

export type NarrationStatus = 'running' | 'done' | 'failed' | 'cancelled';

/** Speaking a video's scenes with a voice engine, scene by scene. */
export interface NarrationJobView {
  id: string;
  videoId: string;
  voiceRef: string;
  sceneIds: string[];
  status: NarrationStatus;
  /** Pieces of text spoken or found already spoken, out of all of them. */
  done: number;
  total: number;
  /** The scene being spoken now. */
  sceneId: string | null;
  /** Scenes left out because they have no narration. */
  skipped: string[];
  /** Pieces that were already spoken (a resumed or repeated run reuses them). */
  reused: number;
  error: string | null;
  startedAt: number;
  endedAt: number | null;
}

export interface VoiceEngineView {
  id: 'openai' | 'gemini' | 'elevenlabs' | 'azure' | 'piper' | 'omnivoice';
  label: string;
  /** Why it cannot be used yet (no key, the vault is locked), or null when it can. */
  problem: string | null;
  /** The vault holds its key and is locked; unlocking it makes the engine usable. */
  locked: boolean;
  /**
   * Where its key is set: the app's AI settings (OpenAI, Gemini) or Studio's own (ElevenLabs,
   * Azure); none for an engine on this computer.
   */
  keyIn: 'app' | 'studio' | 'none';
  /** Runs on this computer, installed from Dev Setup. */
  local: boolean;
  /** Everything it speaks is for non-commercial use only (OmniVoice's weights). */
  nonCommercial: boolean;
  /** Speaks with voice profiles, cloned from a recording. */
  clones: boolean;
  pricePerMillionChars: number | null;
  retiresOn: string | null;
}

export interface VoiceView {
  id: string;
  label: string;
  locale?: string;
  gender?: 'female' | 'male';
  /** For non-commercial use only (the voice's license, or the engine's). */
  nonCommercial?: boolean;
  license?: string;
}

/** What the person agrees to before a voice profile is made, shown beside the checkbox and stored. */
export const CONSENT_STATEMENT =
  'This is my own voice, or I have the permission of the person whose voice it is to make and use a copy of it.';

/** A recording of someone's voice that cloning engines speak with, made with their consent. */
export interface VoiceProfileView {
  id: string;
  name: string;
  lang: string;
  seconds: number;
  transcript: string;
  createdAt: number;
  consentAt: number;
  /** Uploaded to the person's ElevenLabs account, where it can be picked as a voice. */
  elevenlabsVoiceId: string | null;
}

export const studioRenderInputs = {
  videoRef: z.object({ videoId: id }),
  start: z.object({
    videoId: id,
    /** The file name without its extension; a name from the title and format when left out. */
    fileName: z.string().trim().min(1).max(120).optional(),
  }),
  jobs: z.object({ videoId: id.optional() }),
  jobRef: z.object({ jobId: id }),
};
export type StartRenderInput = z.infer<typeof studioRenderInputs.start>;

export const RENDER_STATUSES = [
  'queued',
  'running',
  'done',
  'failed',
  'cancelled',
  'interrupted',
] as const;
export type RenderStatus = (typeof RENDER_STATUSES)[number];

export interface RenderJobView {
  id: string;
  videoId: string;
  /** The video's title when the render was asked for. */
  title: string;
  fileName: string;
  status: RenderStatus;
  /** What a running render is doing; null otherwise. */
  phase: 'capture' | 'encode' | null;
  done: number;
  total: number;
  settings: RenderSettings;
  width: number;
  height: number;
  frames: number;
  durationSeconds: number;
  /** The finished file, once there is one. */
  output: string | null;
  error: string | null;
  createdAt: number;
  startedAt: number | null;
  endedAt: number | null;
  /** Picked up again after the app stopped in the middle of it. */
  resumed: boolean;
  /** Chunks taken from the cache instead of being drawn again. */
  reusedChunks: number;
  capturedChunks: number;
  /** The hardware encoder used, or null for the software one. */
  hardware: string | null;
  /**
   * The voices in it that are for non-commercial use only (OmniVoice, some Piper voices), as the
   * render recorded them when it started; empty when the file is free to use commercially.
   */
  nonCommercial: string[];
}

export interface RenderToolsView {
  ffmpeg: { found: boolean; version: string | null };
  ffprobe: { found: boolean };
  /** Why each codec cannot be used here, or null when it can. */
  codecs: Record<Codec, string | null>;
}

export type RenderEstimateView =
  | { ok: false; problems: string[] }
  | {
      ok: true;
      width: number;
      height: number;
      frames: number;
      durationSeconds: number;
      outputBytes: number;
      cacheBytes: number;
      seconds: number;
      /** Things to know before starting, such as space running low. Rendering is still allowed. */
      warnings: string[];
      /** The name the file gets when none is given. */
      fileName: string;
      extension: 'mp4' | 'webm';
    };

export type StudioEvent =
  | { type: 'library-changed' }
  | { type: 'video-changed'; videoId: string; seq: number }
  | { type: 'generation-changed'; videoId: string; generationId: string }
  /** New lines of a running CLI's output, batched. */
  | { type: 'generation-output'; videoId: string; generationId: string; lines: string[] }
  | { type: 'render-changed'; jobId: string; videoId: string }
  /** A render ended on its own (not cancelled), for a notice the user sees wherever they are. */
  | {
      type: 'render-finished';
      jobId: string;
      videoId: string;
      fileName: string;
      ok: boolean;
      error: string | null;
    }
  /** A narration run moved on: a piece spoken, a scene placed, or the run ended. */
  | { type: 'narration-changed'; videoId: string; jobId: string }
  /** A video's media changed: a file imported, or its preview files made. */
  | { type: 'media-changed'; videoId: string }
  /** A render the app stopped in the middle of was picked up again at startup. */
  | { type: 'render-resumed'; jobId: string; videoId: string; fileName: string }
  /** A running render's progress, a few times a second. */
  | {
      type: 'render-progress';
      jobId: string;
      videoId: string;
      phase: 'capture' | 'encode';
      done: number;
      total: number;
    };
