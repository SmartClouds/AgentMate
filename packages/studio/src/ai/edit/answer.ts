import { z } from 'zod';
import { applyOps, type EditOp, OpError } from '../../document/ops.js';
import type { Scene, StudioDocument } from '../../document/schema.js';
import { flicksToSeconds } from '../../time/flicks.js';
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
    };

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
    }
  }
  return { summary: answer.summary, ops, changes };
}

/** Reads an edit answer and checks it against the live document, or says what is wrong. */
export function readEditAnswer(
  text: string,
  doc: StudioDocument,
  makeId: () => string,
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
    return [];
  });
  const language = languageIssues(doc.language, texts);
  if (language.length > 0) return { ok: false, issues: language };
  try {
    const proposal = editToProposal(doc, parsed.data, makeId);
    if (proposal.changes.length === 0) {
      return { ok: false, issues: ['The changes leave the scenario exactly as it was.'] };
    }
    return { ok: true, value: proposal };
  } catch (error) {
    if (error instanceof OpError) return { ok: false, issues: [error.message] };
    throw error;
  }
}
