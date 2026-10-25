import { z } from 'zod';
import { createScene, type Scene, TRANSITIONS, VISUAL_KINDS } from '../document/schema.js';
import {
  type Flicks,
  flicksToSeconds,
  framesToFlicks,
  quantizeToFrame,
  secondsToFlicks,
} from '../time/flicks.js';

/**
 * The shapes an AI CLI answers in. They are kept simpler than the document: seconds instead of
 * flicks, a transition name instead of a spec, no code or params. That is what a model gets right
 * on the first try, and the converters below turn an answer into real scenes and edit ops.
 */

export const AI_TRANSITIONS = ['cut', ...TRANSITIONS] as const;

const title = z.string().trim().min(1).max(200);
const narration = z.string().max(5000);
const onScreenText = z.array(z.string().max(300)).max(12);
const durationSeconds = z.number().min(1).max(600);
const visualKind = z.enum(VISUAL_KINDS);
const visualBrief = z.string().max(5000);
const transition = z.enum(AI_TRANSITIONS);
const musicCue = z.string().max(300);

export const aiSceneSchema = z.object({
  title: title.describe('A short working title for the scene.'),
  narration: narration.describe('What the narrator says in this scene, in the video language.'),
  onScreenText: onScreenText
    .default([])
    .describe('Short lines shown on screen, in the video language. Keep each one brief.'),
  durationSeconds: durationSeconds.describe('How long the scene runs, in seconds.'),
  visualKind: visualKind
    .default('motion')
    .describe('"motion" for animated graphics, which is the usual choice.'),
  visualBrief: visualBrief
    .default('')
    .describe('What the viewer sees: layout, objects, motion. Written for an animator.'),
  transition: transition.default('cut').describe('How this scene hands over to the next one.'),
  musicCue: musicCue.default('').describe('A note on the music under this scene, or empty.'),
});
export type AiScene = z.infer<typeof aiSceneSchema>;

/** The fields an edit may change on an existing scene. Every one is optional, none has a default. */
export const aiScenePatchSchema = z
  .object({
    title,
    narration,
    onScreenText,
    durationSeconds,
    visualKind,
    visualBrief,
    transition,
    musicCue,
    notes: z.string().max(5000),
  })
  .partial()
  .strict()
  .refine((patch) => Object.keys(patch).length > 0, 'A scene change must change something.');
export type AiScenePatch = z.infer<typeof aiScenePatchSchema>;

const TRANSITION_SECONDS = 0.5;

export function toDuration(seconds: number, fps: number): Flicks {
  return Math.max(framesToFlicks(1, fps), quantizeToFrame(secondsToFlicks(seconds), fps));
}

function toTransition(name: AiScene['transition'], fps: number): Scene['transitionOut'] {
  if (name === 'cut') return null;
  return { kind: name, duration: toDuration(TRANSITION_SECONDS, fps) };
}

export function transitionName(scene: Scene): AiScene['transition'] {
  return scene.transitionOut?.kind ?? 'cut';
}

export function toScene(ai: AiScene, id: string, fps: number): Scene {
  return createScene({
    id,
    title: ai.title,
    narration: ai.narration,
    onScreenText: ai.onScreenText,
    targetDuration: toDuration(ai.durationSeconds, fps),
    visualKind: ai.visualKind,
    visualBrief: ai.visualBrief,
    transitionOut: toTransition(ai.transition, fps),
    musicCue: ai.musicCue,
  });
}

/** The document-side patch for an AI scene change. */
export function toScenePatch(patch: AiScenePatch, fps: number): Partial<Omit<Scene, 'id'>> {
  const out: Partial<Omit<Scene, 'id'>> = {};
  if (patch.title !== undefined) out.title = patch.title;
  if (patch.narration !== undefined) out.narration = patch.narration;
  if (patch.onScreenText !== undefined) out.onScreenText = patch.onScreenText;
  if (patch.durationSeconds !== undefined) {
    out.targetDuration = toDuration(patch.durationSeconds, fps);
  }
  if (patch.visualKind !== undefined) out.visualKind = patch.visualKind;
  if (patch.visualBrief !== undefined) out.visualBrief = patch.visualBrief;
  if (patch.transition !== undefined) out.transitionOut = toTransition(patch.transition, fps);
  if (patch.musicCue !== undefined) out.musicCue = patch.musicCue;
  if (patch.notes !== undefined) out.notes = patch.notes;
  return out;
}

/** A scene as the AI sees it in a request: its id plus the answer-shaped fields. */
export function sceneForPrompt(scene: Scene) {
  return {
    id: scene.id,
    title: scene.title,
    narration: scene.narration,
    onScreenText: scene.onScreenText,
    durationSeconds: Math.round(flicksToSeconds(scene.targetDuration) * 10) / 10,
    visualKind: scene.visualKind,
    visualBrief: scene.visualBrief,
    transition: transitionName(scene),
    musicCue: scene.musicCue,
    ...(scene.notes ? { notes: scene.notes } : {}),
  };
}

/** Words models use for a transition, squeezed (lower case, no spaces or dashes), to ours. */
const TRANSITION_ALIASES: Record<string, AiScene['transition']> = {
  none: 'cut',
  hardcut: 'cut',
  fadein: 'fade',
  fadeout: 'fade',
  crossfade: 'fade',
  fadetoblack: 'fadeblack',
  fadethroughblack: 'fadeblack',
  fadetowhite: 'fadewhite',
  fadethroughwhite: 'fadewhite',
  crossdissolve: 'dissolve',
  wipe: 'wipeleft',
  slide: 'slideleft',
  circle: 'circleopen',
  iris: 'circleopen',
};

const squeeze = (text: string) => text.toLowerCase().replace(/[\s_-]+/g, '');

/**
 * Fixes the near misses models make in a scene before it is checked: a transition called
 * "fadeout" or "Cross-Fade", a visual kind called "animation". A strict check would send these
 * back for a whole repair round (a minute or more) over a word; anything not recognised becomes a
 * plain cut or motion graphics, which the user can change on the scene.
 */
export function normalizeScene(value: unknown): unknown {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return value;
  const scene = { ...(value as Record<string, unknown>) };
  if (typeof scene.transition === 'string') {
    const name = squeeze(scene.transition);
    scene.transition = (AI_TRANSITIONS as readonly string[]).includes(name)
      ? name
      : (TRANSITION_ALIASES[name] ?? 'cut');
  }
  if (typeof scene.visualKind === 'string') {
    const kind = scene.visualKind.toLowerCase();
    scene.visualKind = (VISUAL_KINDS as readonly string[]).includes(kind) ? kind : 'motion';
  }
  return scene;
}

/** `scenes[2].narration: Invalid input`, one line per zod issue, for a repair request. */
export function formatIssues(error: z.ZodError, limit = 20): string[] {
  const lines = error.issues.slice(0, limit).map((issue) => {
    const path = issue.path
      .map((part, i) =>
        typeof part === 'number' ? `[${part}]` : `${i === 0 ? '' : '.'}${String(part)}`,
      )
      .join('');
    return path ? `${path}: ${issue.message}` : issue.message;
  });
  if (error.issues.length > limit) lines.push(`... and ${error.issues.length - limit} more.`);
  return lines;
}
