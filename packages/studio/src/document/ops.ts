import { z } from 'zod';
import {
  type Clip,
  clipSchema,
  documentSchema,
  languageSchema,
  renderSettingsSchema,
  type Scene,
  type StudioDocument,
  sceneSchema,
  type Track,
  trackSchema,
} from './schema.js';

/**
 * Every change to a video is a list of edit ops, whether the user dragged a clip or an AI answered
 * "make scene 3 shorter". Applying a list gives the new document and the inverse list that undoes
 * it, and the pair is what the history log keeps. Ops are plain JSON, so they cross IPC and come
 * back from an AI answer as they are, and `parseEditOps` checks them on the way in.
 */

const id = z
  .string()
  .min(1)
  .max(64)
  .regex(/^[A-Za-z0-9_-]+$/);
const index = z.number().int();

const scenePatch = sceneSchema.omit({ id: true }).partial().strict();
const trackPatch = trackSchema.omit({ id: true }).partial().strict();
const clipPatch = clipSchema.omit({ id: true }).partial().strict();

export const editOpSchema = z.discriminatedUnion('op', [
  z
    .object({
      op: z.literal('doc.set'),
      field: z.enum(['title', 'language', 'styleId']),
      value: z.string().max(500).nullable(),
    })
    .superRefine((op, ctx) => {
      const ok =
        op.field === 'styleId'
          ? op.value === null || op.value.length <= 64
          : op.value !== null &&
            (op.field === 'title' || languageSchema.safeParse(op.value).success);
      if (!ok) ctx.addIssue({ code: 'custom', message: `That is not a valid ${op.field}.` });
    }),
  z.object({
    op: z.literal('scenario.set'),
    patch: z
      .object({
        logline: z.string().max(20_000),
        audience: z.string().max(500),
        tone: z.string().max(500),
      })
      .partial()
      .strict(),
  }),
  z.object({ op: z.literal('scene.add'), scene: sceneSchema, index }),
  z.object({ op: z.literal('scene.remove'), sceneId: id }),
  z.object({ op: z.literal('scene.move'), sceneId: id, index }),
  z.object({ op: z.literal('scene.update'), sceneId: id, patch: scenePatch }),
  z.object({ op: z.literal('track.add'), track: trackSchema, index }),
  z.object({ op: z.literal('track.remove'), trackId: id }),
  z.object({ op: z.literal('track.update'), trackId: id, patch: trackPatch }),
  z.object({ op: z.literal('clip.add'), clip: clipSchema, index: index.optional() }),
  z.object({ op: z.literal('clip.remove'), clipId: id }),
  z.object({ op: z.literal('clip.update'), clipId: id, patch: clipPatch }),
  z.object({ op: z.literal('render.set'), patch: renderSettingsSchema.partial().strict() }),
  /** Puts back a whole earlier version. Used by "Restore", so a restore is itself undoable. */
  z.object({ op: z.literal('doc.replace'), document: z.lazy(() => documentSchema) }),
]);

export type EditOp = z.infer<typeof editOpSchema>;

/** Why an op could not be applied, worded for the person who asked for it. */
export class OpError extends Error {
  override name = 'OpError';
}

export function parseEditOps(value: unknown): EditOp[] {
  const result = z.array(editOpSchema).max(1000).safeParse(value);
  if (!result.success) {
    const first = result.error.issues[0];
    throw new OpError(`That is not a valid edit: ${first?.message ?? 'unknown problem'}`);
  }
  return result.data;
}

function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(value, min), max);
}

function findIndex<T extends { id: string }>(items: T[], itemId: string, what: string): number {
  const at = items.findIndex((item) => item.id === itemId);
  if (at < 0) throw new OpError(`There is no ${what} with the id ${itemId}.`);
  return at;
}

function assertFree(items: { id: string }[], itemId: string, what: string): void {
  if (items.some((item) => item.id === itemId)) {
    throw new OpError(`A ${what} with the id ${itemId} already exists.`);
  }
}

/** The previous values of exactly the keys a patch touches, which is the patch that undoes it. */
function previous<T extends object>(target: T, patch: Partial<T>): Partial<T> {
  const old: Partial<T> = {};
  for (const key of Object.keys(patch) as (keyof T)[]) old[key] = structuredClone(target[key]);
  return old;
}

/** Takes the clips matching `test` out of the document, with their places, for an inverse. */
function takeClips(doc: StudioDocument, test: (clip: Clip) => boolean): EditOp[] {
  const restore: EditOp[] = [];
  doc.timeline.clips.forEach((clip, at) => {
    if (test(clip)) restore.push({ op: 'clip.add', clip, index: at });
  });
  doc.timeline.clips = doc.timeline.clips.filter((clip) => !test(clip));
  return restore;
}

/** Applies one op to `doc` in place and returns the ops that undo it, in the order to run them. */
function applyOne(doc: StudioDocument, op: EditOp): EditOp[] {
  const scenes = doc.scenario.scenes;
  const tracks = doc.timeline.tracks;
  const clips = doc.timeline.clips;
  switch (op.op) {
    case 'doc.set': {
      const old = doc[op.field];
      (doc as Record<string, unknown>)[op.field] = op.value;
      return [{ op: 'doc.set', field: op.field, value: old } as EditOp];
    }
    case 'scenario.set': {
      const old = previous(doc.scenario, op.patch);
      Object.assign(doc.scenario, op.patch);
      return [{ op: 'scenario.set', patch: old }];
    }
    case 'scene.add': {
      assertFree(scenes, op.scene.id, 'scene');
      scenes.splice(clamp(op.index, 0, scenes.length), 0, structuredClone(op.scene));
      return [{ op: 'scene.remove', sceneId: op.scene.id }];
    }
    case 'scene.remove': {
      const at = findIndex(scenes, op.sceneId, 'scene');
      const [scene] = scenes.splice(at, 1) as [Scene];
      const clipsBack = takeClips(
        doc,
        (c) => c.source.type === 'scene' && c.source.sceneId === op.sceneId,
      );
      return [{ op: 'scene.add', scene, index: at }, ...clipsBack];
    }
    case 'scene.move': {
      const at = findIndex(scenes, op.sceneId, 'scene');
      const [scene] = scenes.splice(at, 1) as [Scene];
      scenes.splice(clamp(op.index, 0, scenes.length), 0, scene);
      return [{ op: 'scene.move', sceneId: op.sceneId, index: at }];
    }
    case 'scene.update': {
      const scene = scenes[findIndex(scenes, op.sceneId, 'scene')] as Scene;
      const old = previous(scene, op.patch);
      Object.assign(scene, structuredClone(op.patch));
      return [{ op: 'scene.update', sceneId: op.sceneId, patch: old }];
    }
    case 'track.add': {
      assertFree(tracks, op.track.id, 'track');
      tracks.splice(clamp(op.index, 0, tracks.length), 0, structuredClone(op.track));
      return [{ op: 'track.remove', trackId: op.track.id }];
    }
    case 'track.remove': {
      const at = findIndex(tracks, op.trackId, 'track');
      const [track] = tracks.splice(at, 1) as [Track];
      const clipsBack = takeClips(doc, (c) => c.trackId === op.trackId);
      return [{ op: 'track.add', track, index: at }, ...clipsBack];
    }
    case 'track.update': {
      const track = tracks[findIndex(tracks, op.trackId, 'track')] as Track;
      const old = previous(track, op.patch);
      Object.assign(track, op.patch);
      return [{ op: 'track.update', trackId: op.trackId, patch: old }];
    }
    case 'clip.add': {
      assertFree(clips, op.clip.id, 'clip');
      if (!tracks.some((t) => t.id === op.clip.trackId)) {
        throw new OpError(`There is no track with the id ${op.clip.trackId}.`);
      }
      clips.splice(clamp(op.index ?? clips.length, 0, clips.length), 0, structuredClone(op.clip));
      return [{ op: 'clip.remove', clipId: op.clip.id }];
    }
    case 'clip.remove': {
      const at = findIndex(clips, op.clipId, 'clip');
      const [clip] = clips.splice(at, 1) as [Clip];
      return [{ op: 'clip.add', clip, index: at }];
    }
    case 'clip.update': {
      const clip = clips[findIndex(clips, op.clipId, 'clip')] as Clip;
      const old = previous(clip, op.patch);
      Object.assign(clip, structuredClone(op.patch));
      return [{ op: 'clip.update', clipId: op.clipId, patch: old }];
    }
    case 'render.set': {
      const old = previous(doc.renderSettings, op.patch);
      Object.assign(doc.renderSettings, structuredClone(op.patch));
      return [{ op: 'render.set', patch: old }];
    }
    case 'doc.replace': {
      const old = structuredClone(doc);
      for (const key of Object.keys(doc)) delete (doc as Record<string, unknown>)[key];
      Object.assign(doc, structuredClone(op.document));
      return [{ op: 'doc.replace', document: old }];
    }
  }
}

export interface OpsResult {
  document: StudioDocument;
  /** Undoes the whole list when applied to `document`. */
  inverse: EditOp[];
}

/**
 * Applies `ops` in order to a copy of `doc`. All or nothing: an op that does not fit, or a result
 * that would not be a valid document, throws an OpError and the caller's document is unchanged.
 */
export function applyOps(doc: StudioDocument, ops: readonly EditOp[]): OpsResult {
  if (ops.length === 0) return { document: doc, inverse: [] };
  const next = structuredClone(doc);
  const undo: EditOp[][] = [];
  for (const op of ops) undo.push(applyOne(next, op));
  const checked = documentSchema.safeParse(next);
  if (!checked.success) {
    throw new OpError(`That edit would break the video: ${checked.error.issues[0]?.message ?? ''}`);
  }
  return { document: next, inverse: undo.reverse().flat() };
}
