import { z } from 'zod';
import { type Flicks, secondsToFlicks } from '../time/flicks.js';

/**
 * A Studio video as one document: the scenario (what the film says, scene by scene), the timeline
 * (what plays when) and the render settings. Every change to it is an edit op (see ops.ts), and
 * the op log, not this shape, is what is kept forever. All times are whole flicks.
 */

export const STUDIO_SCHEMA_VERSION = 1;

export const ASPECTS = ['16:9', '9:16', '1:1', '4:5'] as const;
export type Aspect = (typeof ASPECTS)[number];

export const RESOLUTIONS = ['720p', '1080p', '1440p', '2160p'] as const;
export type Resolution = (typeof RESOLUTIONS)[number];

export const FRAME_RATES = [24, 30, 60] as const;
export type FrameRate = (typeof FRAME_RATES)[number];

export const QUALITIES = ['draft', 'standard', 'high', 'master'] as const;
export type Quality = (typeof QUALITIES)[number];

export const CODECS = ['h264', 'h265', 'vp9'] as const;
export type Codec = (typeof CODECS)[number];

/**
 * Every aspect has one fixed size that scenes are designed at. A higher resolution only scales
 * the page, so the preview and the render lay out identically.
 */
export const DESIGN_SIZES: Record<Aspect, { width: number; height: number }> = {
  '16:9': { width: 1920, height: 1080 },
  '9:16': { width: 1080, height: 1920 },
  '1:1': { width: 1080, height: 1080 },
  '4:5': { width: 1080, height: 1350 },
};

const RESOLUTION_SCALE: Record<Resolution, number> = {
  '720p': 2 / 3,
  '1080p': 1,
  '1440p': 4 / 3,
  '2160p': 2,
};

export function outputSize(
  aspect: Aspect,
  resolution: Resolution,
): { width: number; height: number; scale: number } {
  const design = DESIGN_SIZES[aspect];
  const scale = RESOLUTION_SCALE[resolution];
  const even = (n: number) => Math.round((n * scale) / 2) * 2;
  return { width: even(design.width), height: even(design.height), scale };
}

/** Names match ffmpeg's xfade transitions, which is what the final render uses. */
export const TRANSITIONS = [
  'fade',
  'fadeblack',
  'fadewhite',
  'dissolve',
  'wipeleft',
  'wiperight',
  'slideleft',
  'slideright',
  'circleopen',
] as const;
export type Transition = (typeof TRANSITIONS)[number];

export const TRACK_KINDS = ['scene', 'video', 'image', 'text', 'voice', 'music', 'sfx'] as const;
export type TrackKind = (typeof TRACK_KINDS)[number];

export const VISUAL_KINDS = ['motion', 'media', 'generated-image', 'generated-video'] as const;
export type VisualKind = (typeof VISUAL_KINDS)[number];

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const flicks = z.number().int().nonnegative();
const positiveFlicks = z.number().int().positive();
const sha256 = z.string().regex(/^[0-9a-f]{64}$/);
const shortText = z.string().max(500);
const longText = z.string().max(20_000);
export const languageSchema = z
  .string()
  .min(2)
  .max(35)
  .regex(/^[A-Za-z]{2,3}(-[A-Za-z0-9]{1,8})*$/);
const direction = z.enum(['auto', 'ltr', 'rtl']);

const transition = z.object({ kind: z.enum(TRANSITIONS), duration: positiveFlicks });
export type TransitionSpec = z.infer<typeof transition>;

export const sceneSchema = z.object({
  id,
  title: shortText,
  narration: longText,
  onScreenText: z.array(shortText).max(50),
  targetDuration: positiveFlicks,
  /** "narration" fits the scene to its voice-over once there is one; "fixed" keeps the duration. */
  timing: z.enum(['narration', 'fixed']),
  visualKind: z.enum(VISUAL_KINDS),
  visualBrief: longText,
  transitionOut: transition.nullable(),
  /** A note on the music track ("upbeat, builds"); the user fills it from their library. */
  musicCue: shortText,
  /** The voice profile or engine voice that narrates this scene. */
  voiceRef: z.string().max(200).nullable(),
  notes: longText,
  code: z.object({ treeHash: sha256.nullable() }),
  params: z.record(z.string().max(64), z.union([z.string().max(2000), z.number(), z.boolean()])),
});
export type Scene = z.infer<typeof sceneSchema>;

export const trackSchema = z.object({
  id,
  kind: z.enum(TRACK_KINDS),
  name: shortText,
  muted: z.boolean(),
  solo: z.boolean(),
  locked: z.boolean(),
  volume: z.number().min(0).max(2),
});
export type Track = z.infer<typeof trackSchema>;

const clipSource = z.discriminatedUnion('type', [
  z.object({ type: z.literal('scene'), sceneId: id }),
  z.object({ type: z.literal('media'), hash: sha256, in: flicks, out: positiveFlicks }),
  z.object({
    type: z.literal('text'),
    text: longText,
    lang: languageSchema,
    dir: direction,
    styleRef: z.string().max(64).optional(),
  }),
]);
export type ClipSource = z.infer<typeof clipSource>;

export const clipSchema = z.object({
  id,
  trackId: id,
  start: flicks,
  duration: positiveFlicks,
  source: clipSource,
  transitionIn: transition.nullable(),
  gain: z.number().min(0).max(4),
  fadeIn: flicks,
  fadeOut: flicks,
});
export type Clip = z.infer<typeof clipSchema>;

export const renderSettingsSchema = z.object({
  aspect: z.enum(ASPECTS),
  resolution: z.enum(RESOLUTIONS),
  fps: z.union([z.literal(24), z.literal(30), z.literal(60)]),
  quality: z.enum(QUALITIES),
  codec: z.enum(CODECS),
  hwEncode: z.boolean(),
  audio: z.object({
    sampleRate: z.literal(48_000),
    lufs: z.number().min(-30).max(-5),
    /** Music drops under the voice while someone speaks. */
    duck: z.boolean().default(true),
  }),
});
export type RenderSettings = z.infer<typeof renderSettingsSchema>;

function uniqueIds(items: { id: string }[], what: string, ctx: z.RefinementCtx, path: string[]) {
  const seen = new Set<string>();
  for (const item of items) {
    if (seen.has(item.id))
      ctx.addIssue({ code: 'custom', path, message: `Duplicate ${what} id ${item.id}.` });
    seen.add(item.id);
  }
}

export const documentSchema = z
  .object({
    schemaVersion: z.literal(STUDIO_SCHEMA_VERSION),
    id,
    title: shortText,
    language: languageSchema,
    styleId: z.string().max(64).nullable(),
    scenario: z.object({
      logline: longText,
      audience: shortText,
      tone: shortText,
      scenes: z.array(sceneSchema).max(500),
    }),
    timeline: z.object({
      tracks: z.array(trackSchema).max(100),
      clips: z.array(clipSchema).max(10_000),
    }),
    renderSettings: renderSettingsSchema,
  })
  .superRefine((doc, ctx) => {
    uniqueIds(doc.scenario.scenes, 'scene', ctx, ['scenario', 'scenes']);
    uniqueIds(doc.timeline.tracks, 'track', ctx, ['timeline', 'tracks']);
    uniqueIds(doc.timeline.clips, 'clip', ctx, ['timeline', 'clips']);
    const tracks = new Set(doc.timeline.tracks.map((t) => t.id));
    const scenes = new Set(doc.scenario.scenes.map((s) => s.id));
    for (const clip of doc.timeline.clips) {
      if (!tracks.has(clip.trackId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Clip ${clip.id} sits on a track that does not exist.`,
        });
      }
      if (clip.source.type === 'scene' && !scenes.has(clip.source.sceneId)) {
        ctx.addIssue({
          code: 'custom',
          message: `Clip ${clip.id} plays a scene that does not exist.`,
        });
      }
    }
  });

export type StudioDocument = z.infer<typeof documentSchema>;

/**
 * Reads a document from disk or from the renderer. A newer schema is refused outright: reading it
 * as this version would drop fields, and the next save would lose them for good.
 */
export function parseDocument(value: unknown): StudioDocument {
  const version =
    typeof value === 'object' && value !== null && 'schemaVersion' in value
      ? (value as { schemaVersion: unknown }).schemaVersion
      : undefined;
  if (typeof version !== 'number') throw new Error('This is not a Studio video.');
  if (version > STUDIO_SCHEMA_VERSION) {
    throw new Error('This video was saved by a newer version of Runova. Update to open it.');
  }
  const result = documentSchema.safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new Error(`The video's data is not valid: ${first?.message ?? 'unknown problem'}`);
  }
  return result.data;
}

const TRACK_NAMES: Record<TrackKind, string> = {
  scene: 'Scenes',
  video: 'Video',
  image: 'Images',
  text: 'Text',
  voice: 'Voice',
  music: 'Music',
  sfx: 'Sound effects',
};

/** The title a video gets when the user leaves it blank; an AI scenario may replace it. */
export const UNTITLED_TITLE = 'Untitled video';

export interface NewDocumentInput {
  id: string;
  title: string;
  language: string;
  aspect?: Aspect;
}

export function createDocument(input: NewDocumentInput): StudioDocument {
  return {
    schemaVersion: STUDIO_SCHEMA_VERSION,
    id: input.id,
    title: input.title,
    language: input.language,
    styleId: null,
    scenario: { logline: '', audience: '', tone: '', scenes: [] },
    timeline: {
      tracks: TRACK_KINDS.map((kind) => ({
        id: `track-${kind}`,
        kind,
        name: TRACK_NAMES[kind],
        muted: false,
        solo: false,
        locked: false,
        volume: 1,
      })),
      clips: [],
    },
    renderSettings: {
      aspect: input.aspect ?? '16:9',
      resolution: '1080p',
      fps: 30,
      quality: 'standard',
      codec: 'h264',
      hwEncode: true,
      audio: { sampleRate: 48_000, lufs: -14, duck: true },
    },
  };
}

export function createScene(input: { id: string } & Partial<Omit<Scene, 'id'>>): Scene {
  return {
    title: '',
    narration: '',
    onScreenText: [],
    targetDuration: secondsToFlicks(5),
    timing: 'narration',
    visualKind: 'motion',
    visualBrief: '',
    transitionOut: null,
    musicCue: '',
    voiceRef: null,
    notes: '',
    code: { treeHash: null },
    params: {},
    ...input,
  };
}

export type { Flicks };
