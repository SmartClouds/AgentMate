import { describe, expect, it } from 'vitest';
import { secondsToFlicks } from '../time/flicks.js';
import { addClipsOps, captionClips, splitCaptions, toPersianDigits, ZWNJ } from './captions.js';

const s = secondsToFlicks;
// "می‌خواهم" and "کتاب‌ها", each joined by a zero-width non-joiner.
const WANT = `می${ZWNJ}خواهم`;
const BOOKS = `کتاب${ZWNJ}ها`;

describe('splitCaptions', () => {
  it('cuts lines at spaces only, so a word joined by a ZWNJ stays whole', () => {
    const text = `من ${WANT} این ${BOOKS} را امروز بخوانم و ${WANT} بنویسم.`;
    const lines = splitCaptions(text, 'fa', { maxChars: 14 });
    expect(lines.join(' ')).toBe(text);
    for (const line of lines) expect(line.length <= 14 || !line.includes(' ')).toBe(true);
    expect(lines.some((l) => l.includes(WANT))).toBe(true);
    expect(lines.some((l) => l.includes(BOOKS))).toBe(true);
    // No line starts or ends with half a word.
    for (const line of lines) {
      expect(line.startsWith(ZWNJ)).toBe(false);
      expect(line.endsWith(ZWNJ)).toBe(false);
    }
  });

  it('starts every sentence on a new line, and gives a long word a line of its own', () => {
    expect(splitCaptions('Hi there. Second one!', 'en', { maxChars: 40 })).toEqual([
      'Hi there.',
      'Second one!',
    ]);
    expect(splitCaptions('a supercalifragilistic b', 'en', { maxChars: 5 })).toEqual([
      'a',
      'supercalifragilistic',
      'b',
    ]);
    expect(splitCaptions('   ', 'en')).toEqual([]);
  });

  it('writes digits the Persian way when asked', () => {
    expect(toPersianDigits('E36 در 2026')).toBe('E۳۶ در ۲۰۲۶');
    expect(splitCaptions('سال 1405 است.', 'fa', { persianDigits: true })).toEqual([
      'سال ۱۴۰۵ است.',
    ]);
  });
});

describe('captionClips', () => {
  it('lays the lines end to end over the span, on whole frames, longer lines for longer', () => {
    let n = 0;
    const clips = captionClips({
      lines: ['short', 'a much longer line here', 'mid line'],
      lang: 'en',
      trackId: 'track-text',
      start: s(2),
      span: s(3),
      fps: 30,
      newId: () => `c${++n}`,
    });
    expect(clips.map((c) => c.id)).toEqual(['c1', 'c2', 'c3']);
    expect(clips[0]?.start).toBe(s(2));
    const frames = clips.map((c) => Math.round((c.duration / s(1)) * 30));
    expect(frames.reduce((a, b) => a + b, 0)).toBe(90);
    expect(frames[1]).toBeGreaterThan(frames[2] as number);
    expect(frames[2]).toBeGreaterThan(frames[0] as number);
    for (let i = 1; i < clips.length; i++) {
      expect(clips[i]?.start).toBe((clips[i - 1]?.start ?? 0) + (clips[i - 1]?.duration ?? 0));
    }
    expect(clips[0]?.source).toEqual({ type: 'text', text: 'short', lang: 'en', dir: 'auto' });
    expect(addClipsOps(clips).map((o) => o.op)).toEqual(['clip.add', 'clip.add', 'clip.add']);
  });

  it('gives every line at least a frame, and nothing for no lines', () => {
    const clips = captionClips({
      lines: ['x'.repeat(500), 'y', 'z'],
      lang: 'en',
      trackId: 't',
      start: 0,
      span: s(0.1),
      fps: 30,
      newId: () => Math.random().toString(36).slice(2),
    });
    expect(clips.every((c) => c.duration >= s(1 / 30))).toBe(true);
    expect(
      captionClips({
        lines: [],
        lang: 'en',
        trackId: 't',
        start: 0,
        span: s(1),
        fps: 30,
        newId: () => 'x',
      }),
    ).toEqual([]);
  });
});
