import { z } from 'zod';
import { DESIGN_SIZES, type StudioDocument } from '../document/schema.js';
import { type StylePreset, styleById } from '../styles/presets.js';
import { CONTENT_LANGUAGES, directionOf } from '../text/languages.js';
import { sceneForPrompt } from './answerShapes.js';
import { editAnswerSchema } from './edit/answer.js';
import { scenarioAnswerSchema } from './scenario/answer.js';

/**
 * The requests Studio sends to an AI CLI. Each one is a whole markdown file (`request.md` in the
 * run's work folder): the user's words, the video as it stands, the rules, and the exact JSON shape
 * to answer in. CLIs that read stdin get the file's text directly; the others get `POINTER_PROMPT`
 * and read the file themselves, which keeps a long request clear of the Windows command-line cap.
 */

export const REQUEST_FILE = 'request.md';

export const POINTER_PROMPT =
  `Read the file ${REQUEST_FILE} in the current folder and do exactly what it asks. ` +
  'Do not create or change any files. Reply with the JSON answer only.';

/** How fast a narrator speaks, used to size narration to a scene's length. */
const WORDS_PER_MINUTE: Record<string, number> = { en: 150, fa: 130, ar: 130, ur: 130 };

function languageName(code: string): { name: string; native: string } {
  const found = CONTENT_LANGUAGES.find((l) => l.code === code.split('-')[0]);
  return found ? { name: found.name, native: found.native } : { name: code, native: code };
}

/** Writing rules for the video's language. Persian and English get their own; others a general set. */
export function languageRules(code: string): string[] {
  const primary = code.split('-')[0]?.toLowerCase() ?? '';
  const { name, native } = languageName(primary);
  const rules = [
    `Write every title, narration line and on-screen line in ${name} (${native}). Only the JSON keys stay in English.`,
  ];
  if (primary === 'fa') {
    rules.push(
      'Write natural, fluent Persian as a Persian writer would, not a translation from English.',
      'Use the zero-width non-joiner (U+200C, نیم‌فاصله) wherever Persian spelling needs it, as in «می‌شود»، «کتاب‌ها» and «خانه‌ی».',
      'Use Persian punctuation: the comma «،», the semicolon «؛», the question mark «؟» and the quotes « ».',
      'Write numbers in on-screen text with Persian digits (۰۱۲۳۴۵۶۷۸۹).',
      'Keep well known brand or product names in their usual form; write everything else in Persian.',
    );
  } else if (primary === 'en') {
    rules.push(
      'Write plain spoken English with short sentences, the way a good narrator talks.',
      'Use sentence case for titles and on-screen text.',
    );
  } else {
    rules.push(`Use ${name} spelling, punctuation and number formats throughout.`);
  }
  if (directionOf(primary) === 'rtl') {
    rules.push(
      'This language reads right to left. Keep on-screen lines short, and do not mix long Latin phrases into them.',
    );
  }
  rules.push('Never use Chinese characters anywhere in the answer.');
  return rules;
}

function styleGuide(style: StylePreset): string {
  return [
    `**${style.name}**: ${style.summary}`,
    `- Palette: ${style.palette.join(', ')} (background first).`,
    `- Motion: ${style.motion}`,
    `- Do: ${style.dos.join('; ')}.`,
    `- Avoid: ${style.donts.join('; ')}.`,
  ].join('\n');
}

/** The user's own words, fenced so nothing in them reads as part of the instructions. */
function quoted(text: string): string {
  const fence = text.includes('~~~~') ? '~~~~~~' : '~~~~';
  return `${fence}text\n${text.trim()}\n${fence}`;
}

function schemaBlock(schema: z.ZodType): string {
  return `\`\`\`json\n${JSON.stringify(z.toJSONSchema(schema, { io: 'input' }), null, 2)}\n\`\`\``;
}

function videoFacts(doc: StudioDocument): string[] {
  const size = DESIGN_SIZES[doc.renderSettings.aspect];
  const { name } = languageName(doc.language);
  return [
    `- Language: ${name} (${doc.language}), ${directionOf(doc.language) === 'rtl' ? 'right to left' : 'left to right'}.`,
    `- Format: ${doc.renderSettings.aspect}, designed at ${size.width}x${size.height}.`,
  ];
}

function currentScenario(doc: StudioDocument) {
  return {
    title: doc.title,
    logline: doc.scenario.logline,
    audience: doc.scenario.audience,
    tone: doc.scenario.tone,
    scenes: doc.scenario.scenes.map(sceneForPrompt),
  };
}

export interface ScenarioRequestInput {
  brief: string;
  document: StudioDocument;
  /** About how long the video should run. */
  targetSeconds: number;
  styleId?: string | null;
}

export function buildScenarioRequest(input: ScenarioRequestInput): string {
  const { document: doc, targetSeconds } = input;
  const style = styleById(input.styleId ?? doc.styleId);
  const primary = doc.language.split('-')[0] ?? 'en';
  const wpm = WORDS_PER_MINUTE[primary] ?? 140;
  const sceneCount = Math.max(3, Math.round(targetSeconds / 7));
  const sections = [
    '# Write a video scenario',
    'You are a scriptwriter for short animated videos. Write the scenario for the video described below: what the narrator says, what appears on screen, and what the viewer sees, scene by scene.',
    '## What the user wants',
    quoted(input.brief),
    '## The video',
    [
      ...videoFacts(doc),
      `- Length: about ${targetSeconds} seconds in all. The scene durations should add up to within 10% of that.`,
      `- Scenes: about ${sceneCount}, each between 3 and 15 seconds.`,
    ].join('\n'),
    style ? `## Visual style\n${styleGuide(style)}` : '',
    '## Writing rules',
    [
      ...languageRules(doc.language).map((rule) => `- ${rule}`),
      `- A narrator speaks about ${wpm} words a minute. Size each scene's narration to its duration.`,
      '- Open with a hook in the first scene and end with a clear close or call to action.',
      '- On-screen text is a few words per line, never whole narration sentences.',
      '- The visual brief tells an animator what to draw and how it moves, in the visual style above. Use original graphics: no real people, logos or copyrighted characters.',
    ].join('\n'),
    doc.scenario.scenes.length > 0
      ? `## The current scenario\nThe video already has this scenario. Write a new one that does what the user asks; reuse what still fits.\n\`\`\`json\n${JSON.stringify(currentScenario(doc))}\n\`\`\``
      : '',
    '## How to answer',
    'Answer with one JSON object and nothing else: no explanation, no markdown around it. It must match this JSON Schema:',
    schemaBlock(scenarioAnswerSchema),
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

export interface EditRequestInput {
  instruction: string;
  document: StudioDocument;
}

export function buildEditRequest(input: EditRequestInput): string {
  const doc = input.document;
  const style = styleById(doc.styleId);
  const sections = [
    '# Change a video scenario',
    'You are editing the scenario of a short animated video. Make the change the user asks for, and only that change.',
    '## What the user asks',
    quoted(input.instruction),
    '## The video',
    [
      ...videoFacts(doc),
      ...(style ? [`- Visual style: ${style.name}. ${style.summary}`] : []),
    ].join('\n'),
    '## The scenario now',
    `\`\`\`json\n${JSON.stringify(currentScenario(doc), null, 1)}\n\`\`\``,
    '## Rules',
    [
      ...languageRules(doc.language).map((rule) => `- ${rule}`),
      '- Refer to scenes by their "id". New scenes get no id; place them with "after" (the id of the scene before, or null for first).',
      '- Change as little as you can. Leave out every field you do not change.',
      '- If the request cannot be done on the scenario (for example it is about colors in the animation), make the closest change to the scene notes or visual brief.',
    ].join('\n'),
    '## How to answer',
    'Answer with one JSON object and nothing else. It must match this JSON Schema:',
    schemaBlock(editAnswerSchema),
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

/** Longest previous answer quoted back in a repair request. */
const MAX_QUOTED_ANSWER = 30_000;

/**
 * A repair round. Each CLI run starts fresh, so it carries the original request, the answer that
 * failed and the exact problems found in it.
 */
export function buildRepairRequest(original: string, answer: string, issues: string[]): string {
  const shown =
    answer.length > MAX_QUOTED_ANSWER
      ? `${answer.slice(0, MAX_QUOTED_ANSWER)}\n... (cut here)`
      : answer;
  return [
    '# Fix your previous answer',
    'Your previous answer to the request below could not be used. These are the problems:',
    issues.map((issue) => `- ${issue}`).join('\n'),
    'Answer again with the whole corrected JSON object only.',
    '## Your previous answer',
    quoted(shown || '(empty)'),
    '## The original request',
    original,
  ].join('\n\n');
}
