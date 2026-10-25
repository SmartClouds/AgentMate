import type { EditOp } from '../document/ops.js';
import type { Clip } from '../document/schema.js';
import { type Flicks, flicksToFrame, framesToFlicks } from '../time/flicks.js';

/**
 * Captions from a scene's narration: the text cut into short lines at word boundaries (never
 * inside a word, so a Persian word joined by a zero-width non-joiner stays whole), each shown for
 * a share of the scene's time in proportion to its length. Word timings from the voice (E36) will
 * time them exactly; until then the split by length is close enough to read along.
 */

/** Zero-width non-joiner: joins the parts of a Persian word without joining their letters. */
export const ZWNJ = String.fromCodePoint(0x200c);

const PERSIAN_DIGITS = ['۰', '۱', '۲', '۳', '۴', '۵', '۶', '۷', '۸', '۹'];

export function toPersianDigits(text: string): string {
  return text.replace(/[0-9]/g, (d) => PERSIAN_DIGITS[Number(d)] as string);
}

export interface CaptionOptions {
  /** The longest line, in characters; a single longer word gets a line of its own. */
  maxChars?: number;
  persianDigits?: boolean;
}

/**
 * Splits text into caption lines, sentence by sentence, at spaces only. Each sentence starts a new
 * line, so a caption never runs from the end of one sentence into the next.
 */
export function splitCaptions(text: string, lang: string, options: CaptionOptions = {}): string[] {
  const max = options.maxChars ?? 42;
  const lines: string[] = [];
  const sentences = new Intl.Segmenter(lang, { granularity: 'sentence' });
  for (const { segment: sentence } of sentences.segment(text)) {
    // Words are whatever lies between spaces; a ZWNJ is not a space, so it stays inside its word.
    const words = sentence.split(/\s+/).filter(Boolean);
    let line = '';
    for (const word of words) {
      const next = line ? `${line} ${word}` : word;
      if (line && next.length > max) {
        lines.push(line);
        line = word;
      } else {
        line = next;
      }
    }
    if (line) lines.push(line);
  }
  return options.persianDigits ? lines.map(toPersianDigits) : lines;
}

/**
 * Text clips for the lines, laid end to end over `span`, each on a whole frame and lasting in
 * proportion to its length, at least `minimum`.
 */
export function captionClips(input: {
  lines: string[];
  lang: string;
  trackId: string;
  start: Flicks;
  span: Flicks;
  fps: number;
  newId: () => string;
}): Clip[] {
  const { lines, fps } = input;
  if (lines.length === 0) return [];
  const totalFrames = Math.max(lines.length, flicksToFrame(input.span, fps, 'floor'));
  const weights = lines.map((l) => Math.max(1, l.length));
  const sum = weights.reduce((a, b) => a + b, 0);
  const startFrame = flicksToFrame(input.start, fps, 'round');
  const clips: Clip[] = [];
  let used = 0;
  lines.forEach((text, i) => {
    const left = lines.length - i;
    const share =
      i === lines.length - 1
        ? totalFrames - used
        : Math.max(
            1,
            Math.min(
              totalFrames - used - (left - 1),
              Math.round((totalFrames * (weights[i] as number)) / sum),
            ),
          );
    clips.push({
      id: input.newId(),
      trackId: input.trackId,
      start: framesToFlicks(startFrame + used, fps),
      duration: framesToFlicks(share, fps),
      source: { type: 'text', text, lang: input.lang, dir: 'auto' },
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    used += share;
  });
  return clips;
}

/** Ops that add the clips, for one undo step. */
export function addClipsOps(clips: Clip[]): EditOp[] {
  return clips.map((clip) => ({ op: 'clip.add', clip }));
}
