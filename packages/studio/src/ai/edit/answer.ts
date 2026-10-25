import { z } from 'zod';
import { applyOps, type EditOp, OpError } from '../../document/ops.js';
import type { Clip, Scene, StudioDocument, Track, TrackKind } from '../../document/schema.js';
import { type Flicks, flicksToSeconds, secondsToFlicks } from '../../time/flicks.js';
import { addClipsOps, captionClips, splitCaptions } from '../../timeline/captions.js';
import {
  addMediaClip,
  addTextClip,
  type MediaKind,
  moveClip,
  removeClip,
  TimelineError,
  TRACKS_FOR,
  trimClip,
  updateClip,
} from '../../timeline/edits.js';
import { overlapsOnTrack, sceneBlocks, trackFor } from '../../timeline/layout.js';
import {
  type AiScenePatch,
  aiScenePatchSchema,
  aiSceneSchema,
  formatIssues,
  normalizeScene,
  toScene,
  toScenePatch,
  transitionName,
} from '../answerShapes.js';
import { extractJson } from '../extractJson.js';
import type { AnswerRead } from '../scenario/answer.js';
import { languageIssues } from '../scriptCheck.js';

/**
 * Edit by typing. The AI gets the scenario with scene ids and answers with a short summary and a
 * list of changes in a small dialect (scene ids and "after", seconds instead of flicks). This file
 * checks that answer against the live document and turns it into real edit ops, plus a list of
 * readable changes the user approves before anything is applied.
 */

const sceneId = z.string().min(1).max(64);
const clipId = z.string().min(1).max(64);
const atSeconds = z.number().min(0).max(36_000);
const lengthSeconds = z.number().positive().max(36_000);
export const AI_TRACKS = ['video', 'image', 'text', 'voice', 'music', 'sfx'] as const;
const trackKind = z.enum(AI_TRACKS);

export const aiEditOpSchema = z.discriminatedUnion('op', [
  z.object({ op: z.literal('title.set'), value: z.string().trim().min(1).max(200) }),
  z.object({
    op: z.literal('scenario.set'),
    patch: z
      .object({
        logline: z.string().max(2000),
        audience: z.string().max(500),
        tone: z.string().max(500),
      })
      .partial()
      .strict()
      .refine((p) => Object.keys(p).length > 0, 'A scenario change must change something.'),
  }),
  z.object({
    op: z.literal('scene.add'),
    after: sceneId.nullable().describe('The scene the new one goes after, or null for first.'),
    scene: aiSceneSchema,
  }),
  z.object({ op: z.literal('scene.remove'), sceneId }),
  z.object({
    op: z.literal('scene.move'),
    sceneId,
    after: sceneId.nullable().describe('The scene it goes after, or null for first.'),
  }),
  z.object({ op: z.literal('scene.update'), sceneId, patch: aiScenePatchSchema }),
  z.object({
    op: z.literal('clip.add'),
    track: trackKind,
    file: z
      .string()
      .max(300)
      .optional()
      .describe('A file from the files list, by name. Not for text.'),
    text: z
      .string()
      .trim()
      .min(1)
      .max(2000)
      .optional()
      .describe('The words of a caption, for the text track.'),
    startSeconds: atSeconds.describe('Seconds from the start of the video.'),
    durationSeconds: lengthSeconds.optional(),
    volume: z.number().min(0).max(4).optional().describe('1 is as recorded.'),
  }),
  z
    .object({
      op: z.literal('clip.update'),
      clipId,
      startSeconds: atSeconds.optional(),
      durationSeconds: lengthSeconds.optional(),
      volume: z.number().min(0).max(4).optional(),
      fadeInSeconds: z.number().min(0).max(60).optional(),
      fadeOutSeconds: z.number().min(0).max(60).optional(),
      text: z.string().trim().min(1).max(2000).optional(),
    })
    .refine((op) => Object.keys(op).length > 2, 'A clip change must change something.'),
  z.object({ op: z.literal('clip.remove'), clipId }),
  z.object({
    op: z.literal('captions.fromNarration'),
    sceneId: sceneId.describe("Captions for this scene's narration, timed over the scene."),
  }),
  z
    .object({
      op: z.literal('track.set'),
      track: trackKind,
      muted: z.boolean().optional(),
      volume: z.number().min(0).max(2).optional(),
    })
    .refine(
      (op) => op.muted !== undefined || op.volume !== undefined,
      'A track change must change something.',
    ),
]);
export type AiEditOp = z.infer<typeof aiEditOpSchema>;

export const editAnswerSchema = z.object({
  summary: z.string().trim().min(1).max(500).describe('One sentence on what you changed.'),
  ops: z.array(aiEditOpSchema).min(1).max(200),
});
export type EditAnswer = z.infer<typeof editAnswerSchema>;

export interface FieldChange {
  field: string;
  label: string;
  before: string;
  after: string;
}

export type ProposalChange =
  | { kind: 'title'; before: string; after: string }
  | { kind: 'scenario'; changes: FieldChange[] }
  | { kind: 'scene-added'; sceneId: string; position: number; title: string; narration: string }
  | { kind: 'scene-removed'; sceneId: string; position: number; title: string }
  | { kind: 'scene-moved'; sceneId: string; title: string; from: number; to: number }
  | {
      kind: 'scene-changed';
      sceneId: string;
      position: number;
      title: string;
      changes: FieldChange[];
    }
  | { kind: 'clip-added'; clipId: string; track: string; label: string; startSeconds: number }
  | { kind: 'clip-removed'; clipId: string; track: string; label: string }
  | { kind: 'clip-changed'; clipId: string; track: string; label: string; changes: FieldChange[] }
  | { kind: 'captions-added'; sceneId: string; position: number; count: number }
  | { kind: 'track-changed'; track: string; changes: FieldChange[] };

/** An imported file, as an edit by typing may name it. */
export interface EditMedia {
  hash: string;
  name: string;
  kind: MediaKind;
  duration: Flicks | null;
}

/** What an edit needs besides the document. */
export interface EditContext {
  media: readonly EditMedia[];
}

export interface EditProposal {
  summary: string;
  ops: EditOp[];
  changes: ProposalChange[];
}

const SCENE_LABELS: Record<keyof AiScenePatch, string> = {
  title: 'Title',
  narration: 'Narration',
  onScreenText: 'On-screen text',
  durationSeconds: 'Length',
  visualKind: 'Visual type',
  visualBrief: 'Visual brief',
  transition: 'Transition',
  musicCue: 'Music',
  notes: 'Notes',
};

function seconds(scene: Scene): string {
  return `${Math.round(flicksToSeconds(scene.targetDuration) * 10) / 10} s`;
}

function sceneField(scene: Scene, field: keyof AiScenePatch): string {
  switch (field) {
    case 'durationSeconds':
      return seconds(scene);
    case 'onScreenText':
      return scene.onScreenText.join('\n');
    case 'transition':
      return transitionName(scene);
    default:
      return String(scene[field] ?? '');
  }
}

function positionAfter(scenes: Scene[], after: string | null): number {
  if (after === null) return 0;
  const at = scenes.findIndex((s) => s.id === after);
  if (at < 0) throw new OpError(`There is no scene with the id ${after}.`);
  return at + 1;
}

/**
 * Turns the AI's changes into edit ops against `doc`, applying them one by one to a working copy
 * so each "after" and each id is checked against the scenes as they stand at that point.
 */
export function editToProposal(
  doc: StudioDocument,
  answer: EditAnswer,
  makeId: () => string,
  context: EditContext = { media: [] },
): EditProposal {
  const fps = doc.renderSettings.fps;
  let work = doc;
  const ops: EditOp[] = [];
  const changes: ProposalChange[] = [];
  const step = (op: EditOp) => {
    work = applyOps(work, [op]).document;
    ops.push(op);
  };
  const find = (id: string) => {
    const at = work.scenario.scenes.findIndex((s) => s.id === id);
    if (at < 0) throw new OpError(`There is no scene with the id ${id}.`);
    return { at, scene: work.scenario.scenes[at] as Scene };
  };
  const timeline = (edit: { ops: EditOp[] } | null) => {
    for (const op of edit?.ops ?? []) step(op);
  };
  const mediaKind = (hash: string) => context.media.find((m) => m.hash === hash)?.kind;
  const clipOf = (id: string) => {
    const clip = work.timeline.clips.find((c) => c.id === id);
    if (!clip) throw new OpError(`There is no clip with the id ${id}.`);
    return clip;
  };
  const trackName = (clip: Clip) =>
    work.timeline.tracks.find((t) => t.id === clip.trackId)?.name ?? '';
  const clipLabel = (clip: Clip) => {
    if (clip.source.type === 'text') return `"${clip.source.text.slice(0, 60)}"`;
    if (clip.source.type === 'media') {
      const hash = clip.source.hash;
      return context.media.find((m) => m.hash === hash)?.name ?? 'a file';
    }
    return 'a clip';
  };
  const clipFacts = (clip: Clip) => ({
    start: `${round(flicksToSeconds(clip.start))} s`,
    length: `${round(flicksToSeconds(clip.duration))} s`,
    volume: `${Math.round(clip.gain * 100)}%`,
    fadeIn: `${round(flicksToSeconds(clip.fadeIn))} s`,
    fadeOut: `${round(flicksToSeconds(clip.fadeOut))} s`,
    text: clip.source.type === 'text' ? clip.source.text : '',
  });
  const trackOf = (kind: TrackKind): Track => {
    const track = trackFor(work, kind);
    if (!track) throw new OpError(`The video has no ${kind} track.`);
    return track;
  };

  for (const op of answer.ops) {
    switch (op.op) {
      case 'title.set':
        changes.push({ kind: 'title', before: work.title, after: op.value });
        step({ op: 'doc.set', field: 'title', value: op.value });
        break;
      case 'scenario.set': {
        const fields = Object.keys(op.patch) as (keyof typeof op.patch)[];
        const labels = { logline: 'Logline', audience: 'Audience', tone: 'Tone' };
        changes.push({
          kind: 'scenario',
          changes: fields.map((field) => ({
            field,
            label: labels[field],
            before: work.scenario[field],
            after: op.patch[field] ?? '',
          })),
        });
        step({ op: 'scenario.set', patch: op.patch });
        break;
      }
      case 'scene.add': {
        const index = positionAfter(work.scenario.scenes, op.after);
        const scene = toScene(op.scene, makeId(), fps);
        step({ op: 'scene.add', scene, index });
        changes.push({
          kind: 'scene-added',
          sceneId: scene.id,
          position: index + 1,
          title: scene.title,
          narration: scene.narration,
        });
        break;
      }
      case 'scene.remove': {
        const { at, scene } = find(op.sceneId);
        changes.push({
          kind: 'scene-removed',
          sceneId: scene.id,
          position: at + 1,
          title: scene.title,
        });
        step({ op: 'scene.remove', sceneId: op.sceneId });
        break;
      }
      case 'scene.move': {
        const { at, scene } = find(op.sceneId);
        if (op.after === op.sceneId) throw new OpError('A scene cannot move after itself.');
        const rest = work.scenario.scenes.filter((s) => s.id !== op.sceneId);
        const index = positionAfter(rest, op.after);
        step({ op: 'scene.move', sceneId: op.sceneId, index });
        if (index !== at) {
          changes.push({
            kind: 'scene-moved',
            sceneId: scene.id,
            title: scene.title,
            from: at + 1,
            to: index + 1,
          });
        }
        break;
      }
      case 'scene.update': {
        const { at, scene } = find(op.sceneId);
        const patch = toScenePatch(op.patch, fps);
        step({ op: 'scene.update', sceneId: op.sceneId, patch });
        const after = find(op.sceneId).scene;
        const fields = (Object.keys(op.patch) as (keyof AiScenePatch)[]).filter(
          (field) => sceneField(scene, field) !== sceneField(after, field),
        );
        if (fields.length > 0) {
          changes.push({
            kind: 'scene-changed',
            sceneId: scene.id,
            position: at + 1,
            title: after.title,
            changes: fields.map((field) => ({
              field,
              label: SCENE_LABELS[field],
              before: sceneField(scene, field),
              after: sceneField(after, field),
            })),
          });
        }
        break;
      }
      case 'clip.add': {
        const track = trackOf(op.track);
        const id = makeId();
        const at = secondsToFlicks(op.startSeconds);
        if (op.track === 'text') {
          if (!op.text) throw new OpError('A text clip needs its words in "text".');
          const duration = op.durationSeconds ? secondsToFlicks(op.durationSeconds) : undefined;
          timeline(
            addTextClip(work, {
              id,
              trackId: track.id,
              text: op.text,
              lang: work.language,
              at,
              duration,
            }),
          );
        } else {
          const wanted = (op.file ?? '').trim().toLowerCase();
          const file = context.media.find(
            (m) => m.name.toLowerCase() === wanted || m.hash === wanted,
          );
          if (!file)
            throw new OpError(`There is no file named "${op.file ?? ''}" in the files list.`);
          if (!TRACKS_FOR[file.kind].includes(op.track)) {
            throw new OpError(
              `${file.name} is ${file.kind === 'image' ? 'an image' : file.kind}, so it goes on a ${TRACKS_FOR[file.kind].join(' or ')} track.`,
            );
          }
          timeline(addMediaClip(work, { id, trackId: track.id, media: file, at }));
          if (op.durationSeconds) {
            const clip = clipOf(id);
            timeline(
              trimClip(
                work,
                id,
                'end',
                clip.start + secondsToFlicks(op.durationSeconds),
                file.duration,
              ),
            );
          }
        }
        if (op.volume !== undefined) timeline(updateClip(work, id, { gain: op.volume }, 'Volume'));
        const added = clipOf(id);
        changes.push({
          kind: 'clip-added',
          clipId: id,
          track: track.name,
          label: clipLabel(added),
          startSeconds: round(flicksToSeconds(added.start)),
        });
        break;
      }
      case 'clip.update': {
        const before = clipOf(op.clipId);
        const facts = clipFacts(before);
        const file =
          before.source.type === 'media'
            ? context.media.find((m) => m.hash === (before.source as { hash: string }).hash)
            : undefined;
        if (op.startSeconds !== undefined) {
          timeline(
            moveClip(work, op.clipId, { start: secondsToFlicks(op.startSeconds) }, mediaKind),
          );
        }
        if (op.durationSeconds !== undefined) {
          const clip = clipOf(op.clipId);
          timeline(
            trimClip(
              work,
              op.clipId,
              'end',
              clip.start + secondsToFlicks(op.durationSeconds),
              file?.duration ?? null,
            ),
          );
        }
        const patch: Parameters<typeof updateClip>[2] = {};
        if (op.volume !== undefined) patch.gain = op.volume;
        if (op.fadeInSeconds !== undefined) patch.fadeIn = secondsToFlicks(op.fadeInSeconds);
        if (op.fadeOutSeconds !== undefined) patch.fadeOut = secondsToFlicks(op.fadeOutSeconds);
        if (op.text !== undefined) patch.text = op.text;
        if (Object.keys(patch).length > 0)
          timeline(updateClip(work, op.clipId, patch, 'Changed a clip'));
        const after = clipFacts(clipOf(op.clipId));
        const labels = {
          start: 'Start',
          length: 'Length',
          volume: 'Volume',
          fadeIn: 'Fade in',
          fadeOut: 'Fade out',
          text: 'Words',
        };
        const changed = (Object.keys(labels) as (keyof typeof labels)[]).filter(
          (k) => facts[k] !== after[k],
        );
        if (changed.length > 0) {
          changes.push({
            kind: 'clip-changed',
            clipId: op.clipId,
            track: trackName(before),
            label: clipLabel(before),
            changes: changed.map((field) => ({
              field,
              label: labels[field],
              before: facts[field],
              after: after[field],
            })),
          });
        }
        break;
      }
      case 'clip.remove': {
        const clip = clipOf(op.clipId);
        changes.push({
          kind: 'clip-removed',
          clipId: clip.id,
          track: trackName(clip),
          label: clipLabel(clip),
        });
        timeline(removeClip(work, op.clipId));
        break;
      }
      case 'captions.fromNarration': {
        const { at, scene } = find(op.sceneId);
        const block = sceneBlocks(work).find((b) => b.sceneId === scene.id);
        const track = trackOf('text');
        const lines = splitCaptions(scene.narration, work.language);
        if (!block || lines.length === 0)
          throw new OpError(`Scene ${at + 1} has no narration to caption.`);
        if (overlapsOnTrack(work, track.id, block.start, block.duration)) {
          throw new OpError(`There are captions over scene ${at + 1} already; remove them first.`);
        }
        const clips = captionClips({
          lines,
          lang: work.language,
          trackId: track.id,
          start: block.start,
          span: block.duration,
          fps,
          newId: makeId,
        });
        for (const clipOp of addClipsOps(clips)) step(clipOp);
        changes.push({
          kind: 'captions-added',
          sceneId: scene.id,
          position: at + 1,
          count: clips.length,
        });
        break;
      }
      case 'track.set': {
        const track = trackOf(op.track);
        const fields: FieldChange[] = [];
        const patch: Partial<Track> = {};
        if (op.muted !== undefined && op.muted !== track.muted) {
          patch.muted = op.muted;
          fields.push({
            field: 'muted',
            label: 'Muted',
            before: track.muted ? 'Yes' : 'No',
            after: op.muted ? 'Yes' : 'No',
          });
        }
        if (op.volume !== undefined && op.volume !== track.volume) {
          patch.volume = op.volume;
          fields.push({
            field: 'volume',
            label: 'Volume',
            before: `${Math.round(track.volume * 100)}%`,
            after: `${Math.round(op.volume * 100)}%`,
          });
        }
        if (fields.length > 0) {
          step({ op: 'track.update', trackId: track.id, patch });
          changes.push({ kind: 'track-changed', track: track.name, changes: fields });
        }
        break;
      }
    }
  }
  return { summary: answer.summary, ops, changes };
}

function round(value: number): number {
  return Math.round(value * 100) / 100;
}

/** Reads an edit answer and checks it against the live document, or says what is wrong. */
export function readEditAnswer(
  text: string,
  doc: StudioDocument,
  makeId: () => string,
  context: EditContext = { media: [] },
): AnswerRead<EditProposal> {
  const json = extractJson(text);
  if (!json.ok) return { ok: false, issues: [json.reason] };
  const ops = json.value.ops;
  if (Array.isArray(ops)) {
    json.value.ops = ops.map((op: unknown) => {
      if (typeof op !== 'object' || op === null) return op;
      const entry = op as Record<string, unknown>;
      if (entry.op === 'scene.add') return { ...entry, scene: normalizeScene(entry.scene) };
      if (entry.op === 'scene.update') return { ...entry, patch: normalizeScene(entry.patch) };
      return entry;
    });
  }
  const parsed = editAnswerSchema.safeParse(json.value);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  const texts = parsed.data.ops.flatMap((op) => {
    if (op.op === 'scene.add') return [op.scene.narration, ...op.scene.onScreenText];
    if (op.op === 'scene.update')
      return [op.patch.narration ?? '', ...(op.patch.onScreenText ?? [])];
    if ((op.op === 'clip.add' || op.op === 'clip.update') && op.text) return [op.text];
    return [];
  });
  const language = languageIssues(doc.language, texts);
  if (language.length > 0) return { ok: false, issues: language };
  try {
    const proposal = editToProposal(doc, parsed.data, makeId, context);
    if (proposal.changes.length === 0) {
      return { ok: false, issues: ['The changes leave the scenario exactly as it was.'] };
    }
    return { ok: true, value: proposal };
  } catch (error) {
    if (error instanceof OpError || error instanceof TimelineError) {
      return { ok: false, issues: [error.message] };
    }
    throw error;
  }
}
