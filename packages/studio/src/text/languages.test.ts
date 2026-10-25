import { describe, expect, it } from 'vitest';
import {
  CONTENT_LANGUAGES,
  directionOf,
  isChineseLanguage,
  isContentLanguage,
  withoutChinese,
} from './languages.js';

describe('content languages', () => {
  it('offers Persian and English first, each with its writing direction', () => {
    expect(CONTENT_LANGUAGES.slice(0, 2).map((l) => l.code)).toEqual(['fa', 'en']);
    expect(CONTENT_LANGUAGES.find((l) => l.code === 'fa')?.dir).toBe('rtl');
    expect(CONTENT_LANGUAGES.find((l) => l.code === 'en')?.dir).toBe('ltr');
  });

  it('never offers Chinese in any form', () => {
    expect(CONTENT_LANGUAGES.some((l) => isChineseLanguage(l.code))).toBe(false);
  });

  it.each(['zh', 'zh-CN', 'zh-Hant-TW', 'cmn', 'cmn-Hans', 'yue', 'ZH-tw', 'lzh', 'wuu', 'nan'])(
    'recognises %s as Chinese',
    (tag) => {
      expect(isChineseLanguage(tag)).toBe(true);
    },
  );

  it.each(['fa', 'en-US', 'ja', 'ko', 'zu', 'za', 'hi'])(
    'does not mistake %s for Chinese',
    (tag) => {
      expect(isChineseLanguage(tag)).toBe(false);
    },
  );

  it('drops Chinese entries from a provider list, keeping everything else in order', () => {
    const voices = [
      { id: 'a', language: 'en-US' },
      { id: 'b', language: 'zh-CN' },
      { id: 'c', language: 'fa-IR' },
      { id: 'd', language: 'cmn' },
    ];
    expect(withoutChinese(voices, (v) => v.language).map((v) => v.id)).toEqual(['a', 'c']);
  });

  it('knows which languages are written right to left', () => {
    expect(directionOf('fa-IR')).toBe('rtl');
    expect(directionOf('ar')).toBe('rtl');
    expect(directionOf('ur')).toBe('rtl');
    expect(directionOf('he')).toBe('rtl');
    expect(directionOf('en-GB')).toBe('ltr');
    expect(directionOf('tr')).toBe('ltr');
  });

  it('accepts only the languages it offers as a video language', () => {
    expect(isContentLanguage('fa')).toBe(true);
    expect(isContentLanguage('zh')).toBe(false);
    expect(isContentLanguage('xx')).toBe(false);
  });
});
