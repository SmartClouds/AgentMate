/**
 * Text for speaking: cut into pieces an engine takes in one request, at sentence ends where it can
 * and at spaces where a sentence is too long, never inside a word (a Persian word joined by a
 * zero-width non-joiner stays whole). And word timings, from an engine's character timings or,
 * without them, from each word's share of the length.
 */

/** The longest piece sent in one request: well under every engine's limit, short enough to retry. */
export const MAX_SPEECH_CHARS = 600;

export function speechChunks(text: string, lang: string, maxChars = MAX_SPEECH_CHARS): string[] {
  const chunks: string[] = [];
  let current = '';
  const push = () => {
    if (current.trim()) chunks.push(current.trim());
    current = '';
  };
  const sentences = new Intl.Segmenter(lang, { granularity: 'sentence' });
  for (const { segment } of sentences.segment(text)) {
    const sentence = segment.trim();
    if (!sentence) continue;
    if (sentence.length > maxChars) {
      push();
      // A sentence too long for one request is cut at spaces.
      for (const word of sentence.split(/\s+/)) {
        if (current && current.length + 1 + word.length > maxChars) push();
        current = current ? `${current} ${word}` : word;
      }
      push();
      continue;
    }
    if (current && current.length + 1 + sentence.length > maxChars) push();
    current = current ? `${current} ${sentence}` : sentence;
  }
  push();
  return chunks;
}

export interface WordTiming {
  word: string;
  /** Seconds from the start of the narration. */
  start: number;
  end: number;
}

/** Words from per-character timings (as ElevenLabs gives them), words being runs without spaces. */
export function wordsFromCharacters(
  characters: readonly string[],
  starts: readonly number[],
  ends: readonly number[],
  offset = 0,
): WordTiming[] {
  const words: WordTiming[] = [];
  let word = '';
  let start = 0;
  let end = 0;
  characters.forEach((ch, i) => {
    if (/\s/.test(ch)) {
      if (word) words.push({ word, start: start + offset, end: end + offset });
      word = '';
      return;
    }
    if (!word) start = starts[i] ?? end;
    word += ch;
    end = ends[i] ?? start;
  });
  if (word) words.push({ word, start: start + offset, end: end + offset });
  return words;
}

/** Words spread over `seconds` by their length, for engines that give no timings. */
export function wordsByLength(text: string, seconds: number, offset = 0): WordTiming[] {
  const words = text.split(/\s+/).filter(Boolean);
  const total = words.reduce((sum, w) => sum + w.length, 0);
  if (total === 0) return [];
  const timings: WordTiming[] = [];
  let at = offset;
  for (const word of words) {
    const length = (seconds * word.length) / total;
    timings.push({ word, start: at, end: at + length });
    at += length;
  }
  return timings;
}

export interface TimedLine {
  text: string;
  start: number;
  end: number;
}

/**
 * Caption lines timed by the words they hold: each line runs from its first word's start to the
 * next line's first word (the last one to its last word's end). Lines and words are matched in
 * order by their words, so a caption never shows ahead of the voice.
 */
export function timeLines(lines: readonly string[], words: readonly WordTiming[]): TimedLine[] {
  const timed: TimedLine[] = [];
  let index = 0;
  for (const line of lines) {
    const count = line.split(/\s+/).filter(Boolean).length;
    const first = words[index];
    const last = words[Math.min(words.length - 1, index + count - 1)];
    if (!first || !last) break;
    timed.push({ text: line, start: first.start, end: last.end });
    index += count;
  }
  for (let i = 0; i < timed.length - 1; i++) {
    const item = timed[i] as TimedLine;
    const next = timed[i + 1] as TimedLine;
    item.end = Math.max(item.end, next.start);
  }
  return timed;
}
