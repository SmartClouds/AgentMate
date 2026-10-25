import { describe, expect, it } from 'vitest';
import { CMN, YUE, ZH } from '../test/chineseTags.js';
import { ZWNJ } from '../timeline/captions.js';
import { speechChunks, timeLines, wordsByLength, wordsFromCharacters } from './text.js';
import { formatVoiceRef, parseVoiceRef, voicesFor, voicesWithoutChinese } from './voices.js';
import { encodeWav, parseWav } from './wav.js';

const WANT = `می${ZWNJ}خواهم`;

describe('speechChunks', () => {
  it('keeps sentences together up to the limit and starts a new piece after one', () => {
    expect(speechChunks('One two. Three four. Five.', 'en', 12)).toEqual([
      'One two.',
      'Three four.',
      'Five.',
    ]);
    expect(speechChunks('One two. Three four. Five.', 'en', 40)).toEqual([
      'One two. Three four. Five.',
    ]);
  });

  it('cuts a sentence too long for one request at spaces, never inside a Persian word', () => {
    const text = `${WANT} ${WANT} ${WANT} ${WANT} ${WANT}.`;
    const chunks = speechChunks(text, 'fa', 20);
    expect(chunks.join(' ')).toBe(text);
    for (const chunk of chunks) {
      expect(chunk.length).toBeLessThanOrEqual(20);
      expect(chunk.split(' ').every((w) => w.replace('.', '') === WANT)).toBe(true);
    }
    expect(speechChunks('   ', 'en')).toEqual([]);
  });
});

describe('word timings', () => {
  it('reads words from character timings, a word being a run without spaces', () => {
    const chars = ['H', 'i', ' ', 'y', 'o', 'u'];
    const starts = [0, 0.1, 0.2, 0.3, 0.4, 0.5];
    const ends = [0.1, 0.2, 0.3, 0.4, 0.5, 0.6];
    expect(wordsFromCharacters(chars, starts, ends, 10)).toEqual([
      { word: 'Hi', start: 10, end: 10.2 },
      { word: 'you', start: 10.3, end: 10.6 },
    ]);
  });

  it('spreads words over the length by their size when an engine gives no timings', () => {
    expect(wordsByLength('ab abcd', 3, 1)).toEqual([
      { word: 'ab', start: 1, end: 2 },
      { word: 'abcd', start: 2, end: 4 },
    ]);
    expect(wordsByLength('  ', 3)).toEqual([]);
  });

  it('times caption lines by their words, each running to the next line', () => {
    const words = wordsByLength('a b c d e', 5);
    expect(timeLines(['a b', 'c d e'], words)).toEqual([
      { text: 'a b', start: 0, end: 2 },
      { text: 'c d e', start: 2, end: 5 },
    ]);
    expect(
      timeLines(['a b', 'c', 'more words than there are'], wordsByLength('a b c', 3)),
    ).toHaveLength(2);
  });
});

describe('WAV files', () => {
  it('writes 16-bit PCM and reads its length back to the sample', () => {
    const pcm = new Uint8Array(48_000 * 2);
    const info = parseWav(encodeWav(pcm, 48_000));
    expect(info).toEqual({
      sampleRate: 48_000,
      channels: 1,
      bitsPerSample: 16,
      dataOffset: 44,
      dataLength: 96_000,
      frames: 48_000,
      seconds: 1,
    });
  });

  it('walks past other chunks, and takes what is there when the length was never filled in', () => {
    const wav = encodeWav(new Uint8Array(24_000 * 4), 24_000, 2);
    const withList = new Uint8Array(wav.length + 12);
    withList.set(wav.subarray(0, 36));
    withList.set([0x4c, 0x49, 0x53, 0x54, 4, 0, 0, 0, 1, 2, 3, 4], 36);
    withList.set(wav.subarray(36), 48);
    expect(parseWav(withList)).toMatchObject({ channels: 2, frames: 24_000, dataOffset: 56 });
    const streamed = encodeWav(new Uint8Array(1000), 24_000);
    new DataView(streamed.buffer).setUint32(40, 0xffffffff, true);
    expect(parseWav(streamed).dataLength).toBe(1000);
  });

  it('says what is wrong with a file that is not a WAV', () => {
    expect(() => parseWav(new Uint8Array(20))).toThrow('That is not a WAV file.');
    const noData = encodeWav(new Uint8Array(0), 8000).subarray(0, 36);
    expect(() => parseWav(noData)).toThrow('The WAV file has no sound in it.');
    const dataFirst = encodeWav(new Uint8Array(4), 8000);
    dataFirst.set([0x64, 0x61, 0x74, 0x61], 12);
    expect(() => parseWav(dataFirst)).toThrow('The WAV file has its sound before its format.');
  });
});

describe('voices', () => {
  it('names a voice as engine and id, and refuses anything else', () => {
    expect(formatVoiceRef({ engine: 'openai', voice: 'coral' })).toBe('openai:coral');
    expect(parseVoiceRef('azure:fa-IR-DilaraNeural')).toEqual({
      engine: 'azure',
      voice: 'fa-IR-DilaraNeural',
    });
    for (const bad of [null, '', 'recording', 'nope:x', 'openai:'])
      expect(parseVoiceRef(bad)).toBeNull();
  });

  it('offers every voice of an engine that speaks any language, and only the language voices of one that does not', () => {
    expect(voicesFor('openai', 'fa').length).toBe(13);
    expect(voicesFor('azure', 'fa').map((v) => v.id)).toEqual([
      'fa-IR-DilaraNeural',
      'fa-IR-FaridNeural',
    ]);
    expect(voicesFor('azure', 'en-US').every((v) => v.locale?.startsWith('en-'))).toBe(true);
    expect(voicesFor('elevenlabs', 'fa', [{ id: 'abc', label: 'Rachel' }])).toEqual([
      { id: 'abc', label: 'Rachel' },
    ]);
  });

  it('never offers a Chinese voice', () => {
    const han = String.fromCodePoint(0x4e91, 0x5e0c);
    const voices = [
      { id: '1', label: 'Yunxi', locale: `${ZH}-CN` },
      { id: '2', label: 'Ming', locale: `${YUE}-HK` },
      { id: '3', label: han },
      { id: '4', label: 'Mandarin', locale: `${CMN}-Hans` },
      { id: '5', label: 'Dilara', locale: 'fa-IR' },
    ];
    expect(voicesWithoutChinese(voices).map((v) => v.id)).toEqual(['5']);
    expect(voicesFor('elevenlabs', 'en', voices).map((v) => v.id)).toEqual([]);
  });
});
