import { DESIGN_SIZES, type StudioDocument } from '../../document/schema.js';
import { styleById } from '../../styles/presets.js';
import { directionOf } from '../../text/languages.js';
import { flicksToSeconds } from '../../time/flicks.js';
import { languageRules } from '../prompts.js';
import type { FencedFile } from './files.js';

/**
 * The request for one scene's motion graphics. The answer is the scene as a small web page,
 * returned as fenced files, which Studio stores as a code tree and checks frame by frame.
 */

export const SCENE_FONTS = ['Vazirmatn', 'Noto Naskh Arabic', 'Inter'] as const;

/** How a scene page works, written for the model that writes one. */
export const SCENE_AUTHORING_GUIDE = `## How a scene page works

- The scene is a web page of exactly the design size given below, in CSS pixels. Give \`html\` and
  \`body\` that size, \`margin: 0\` and \`overflow: hidden\`.
- Studio adds its runtime to the page before your code. Do not add it yourself. Register the scene
  once from your script:

\`\`\`js
Studio.scene({
  setup(ctx) { /* build the DOM, once */ },
  render(t, ctx) { /* draw the moment t seconds in */ },
});
\`\`\`

- \`render(t, ctx)\` must draw from \`t\` alone, never from what an earlier frame did: frames are drawn
  out of order and one at a time, and the same \`t\` must give the same picture every time.
- Time the motion with \`ctx.progress\` (0 to 1 over the scene) so the scene fits any length. Also on
  \`ctx\`: \`duration\`, \`width\`, \`height\`, \`lang\`, \`dir\`, \`params\`, \`between(start, end)\`,
  \`tween(t, from, to, start, end, easing)\`, \`keyframes(t, [{ at, value, easing }])\`,
  \`spring(t, { stiffness, damping })\`, \`lerp\`, \`random()\` (seeded, the same for the same frame)
  and \`noise(x, y)\`. Easings are on \`ctx.ease\`: linear, in, out, inOut, standard, outBack,
  outElastic, outBounce, inCubic, outCubic, inOutCubic.
- CSS animations and transitions also work: Studio pauses them and sets them to each frame's time.
  Canvas and WebGL work through \`render\`.
- The page has no network: no CDN, no web fonts, no fetch. Fonts that are there: ${SCENE_FONTS.map((f) => `"${f}"`).join(', ')}.
  Use "Vazirmatn" for Persian, Arabic and Urdu, "Inter" for other text.
- Draw everything yourself with HTML, CSS, SVG, canvas or WebGL. No images from outside the files you
  return.
- Put the on-screen text in the page exactly as given, with \`lang\` and \`dir\` set on its element.
`;

export interface SceneRequestInput {
  document: StudioDocument;
  sceneId: string;
  /** What the user asked to change, for a new version of existing code. */
  instruction?: string;
  /** The scene's current files, when changing it. */
  current?: FencedFile[];
  /** The style's reference scene, shown as a worked example of the look and of the runtime. */
  example?: FencedFile[];
}

function quoted(text: string): string {
  const fence = text.includes('~~~~') ? '~~~~~~' : '~~~~';
  return `${fence}text\n${text.trim()}\n${fence}`;
}

export function buildSceneRequest(input: SceneRequestInput): string {
  const doc = input.document;
  const index = doc.scenario.scenes.findIndex((s) => s.id === input.sceneId);
  const scene = doc.scenario.scenes[index];
  if (!scene) throw new Error('That scene is not in the video any more.');
  const size = DESIGN_SIZES[doc.renderSettings.aspect];
  const style = styleById(doc.styleId);
  const seconds = Math.round(flicksToSeconds(scene.targetDuration) * 10) / 10;
  const next = doc.scenario.scenes[index + 1];

  const sections = [
    input.current ? '# Change a scene of a video' : '# Animate a scene of a video',
    input.current
      ? 'You are a motion designer. Change the scene below the way the user asks, and return the whole scene again.'
      : 'You are a motion designer. Write the motion graphics for the scene below as a small web page.',
    input.instruction ? `## What the user asks\n\n${quoted(input.instruction)}` : '',
    '## The scene',
    [
      `- Scene ${index + 1} of ${doc.scenario.scenes.length}: ${scene.title}`,
      `- Design size: ${size.width}x${size.height} (${doc.renderSettings.aspect}).`,
      `- Length: about ${seconds} seconds; time everything with ctx.progress.`,
      `- Language: ${doc.language}, ${directionOf(doc.language) === 'rtl' ? 'right to left' : 'left to right'}.`,
      next
        ? `- The next scene is "${next.title}"; end on a calm frame it can follow.`
        : '- This is the last scene; end on a frame that can be held.',
    ].join('\n'),
    `What the narrator says (for timing only; it is not shown on screen):\n${quoted(scene.narration || '(no narration)')}`,
    `On-screen text, shown exactly as written:\n${quoted(scene.onScreenText.join('\n') || '(none)')}`,
    `What the viewer sees:\n${quoted(scene.visualBrief || '(not given; design it from the narration)')}`,
    style
      ? `## Visual style: ${style.name}\n\n${style.summary}\n- Palette: ${style.palette.join(', ')} (background first).\n- Motion: ${style.motion}\n- Do: ${style.dos.join('; ')}.\n- Avoid: ${style.donts.join('; ')}.`
      : '',
    SCENE_AUTHORING_GUIDE,
    input.example && !input.current
      ? `## An example in this style\n\nThis is a different scene in the same style. Learn the look and how it uses the runtime; do not copy its text.\n\n${input.example.map((f) => `\`\`\`${f.path.split('.').pop()} file:${f.path}\n${f.content}\`\`\``).join('\n\n')}`
      : '',
    `## Text rules\n${languageRules(doc.language)
      .map((r) => `- ${r}`)
      .join('\n')}`,
    input.current
      ? `## The scene now\n\n${input.current.map((f) => `\`\`\`${f.path.split('.').pop()} file:${f.path}\n${f.content}\`\`\``).join('\n\n')}`
      : '',
    '## How to answer',
    'Answer with the files of the scene and nothing else, each in its own fenced block with its name on the fence line, like this:\n\n```html file:index.html\n...\n```\n\n```js file:scene.js\n...\n```\n\n`index.html` is required. Keep it to index.html, scene.js and style.css unless the scene needs more.',
  ];
  return `${sections.filter(Boolean).join('\n\n')}\n`;
}

/** A fix round after the scene did not pass its checks. */
export function buildSceneFixRequest(
  original: string,
  files: FencedFile[],
  problems: string[],
): string {
  return [
    '# Fix the scene',
    'The scene you wrote for the request below did not pass its checks. These are the problems:',
    problems.map((p) => `- ${p}`).join('\n'),
    'Return the whole fixed scene, every file, in the same fenced format.',
    '## The scene you wrote',
    files
      .map((f) => `\`\`\`${f.path.split('.').pop()} file:${f.path}\n${f.content}\`\`\``)
      .join('\n\n'),
    '## The original request',
    original,
  ].join('\n\n');
}
