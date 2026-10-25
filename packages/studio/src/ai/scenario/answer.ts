import { z } from 'zod';
import type { EditOp } from '../../document/ops.js';
import type { StudioDocument } from '../../document/schema.js';
import { aiSceneSchema, formatIssues, normalizeScene, toScene } from '../answerShapes.js';
import { extractJson } from '../extractJson.js';
import { languageIssues } from '../scriptCheck.js';

/** What a scenario run answers with: the film's idea and its scenes in order. */
export const scenarioAnswerSchema = z.object({
  title: z.string().trim().min(1).max(200).optional().describe('A title for the video.'),
  logline: z.string().trim().min(1).max(2000).describe('The whole video in one or two sentences.'),
  audience: z.string().max(500).default('').describe('Who the video is for.'),
  tone: z.string().max(500).default('').describe('How it should feel.'),
  scenes: z.array(aiSceneSchema).min(1).max(60).describe('The scenes, in the order they play.'),
});
export type ScenarioAnswer = z.infer<typeof scenarioAnswerSchema>;

export type AnswerRead<T> = { ok: true; value: T } | { ok: false; issues: string[] };

/** Reads a scenario out of an AI answer, or lists what is wrong with it for a repair round. */
export function readScenarioAnswer(text: string, language: string): AnswerRead<ScenarioAnswer> {
  const json = extractJson(text);
  if (!json.ok) return { ok: false, issues: [json.reason] };
  const value = json.value;
  if (Array.isArray(value.scenes)) value.scenes = value.scenes.map(normalizeScene);
  const parsed = scenarioAnswerSchema.safeParse(value);
  if (!parsed.success) return { ok: false, issues: formatIssues(parsed.error) };
  const texts = parsed.data.scenes.flatMap((s) => [s.narration, ...s.onScreenText]);
  const issues = languageIssues(language, [...texts, parsed.data.title ?? '']);
  if (issues.length > 0) return { ok: false, issues };
  return { ok: true, value: parsed.data };
}

/**
 * The edit that puts a scenario answer into the video: one entry that sets the logline, replaces
 * every scene, and renames the video when the answer has a title and the video has none yet.
 */
export function scenarioToOps(
  doc: StudioDocument,
  answer: ScenarioAnswer,
  makeId: () => string,
  options: { keepTitle?: boolean } = {},
): EditOp[] {
  const ops: EditOp[] = [];
  if (answer.title && !options.keepTitle && answer.title !== doc.title) {
    ops.push({ op: 'doc.set', field: 'title', value: answer.title });
  }
  ops.push({
    op: 'scenario.set',
    patch: { logline: answer.logline, audience: answer.audience, tone: answer.tone },
  });
  for (const scene of doc.scenario.scenes) ops.push({ op: 'scene.remove', sceneId: scene.id });
  answer.scenes.forEach((scene, index) => {
    ops.push({
      op: 'scene.add',
      scene: toScene(scene, makeId(), doc.renderSettings.fps),
      index,
    });
  });
  return ops;
}

/** Seconds the scenario runs for, for "about 60 s" in the UI. */
export function scenarioSeconds(answer: ScenarioAnswer): number {
  return answer.scenes.reduce((sum, s) => sum + s.durationSeconds, 0);
}
