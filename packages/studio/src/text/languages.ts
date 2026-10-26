/**
 * The languages a Studio video can be made in. Persian and English come first and are the ones
 * verified end to end; the rest are offered because the CLIs and voice engines handle them.
 * Chinese is never offered, in any of its forms: Runova ships no Chinese content, and every
 * provider list (voices, languages) passes through `withoutChinese` before it is shown.
 */

export interface ContentLanguage {
  code: string;
  /** The English name, shown in the picker. */
  name: string;
  /** The name in the language itself, shown beside it. */
  native: string;
  dir: 'ltr' | 'rtl';
}

export const CONTENT_LANGUAGES: readonly ContentLanguage[] = [
  { code: 'fa', name: 'Persian', native: 'فارسی', dir: 'rtl' },
  { code: 'en', name: 'English', native: 'English', dir: 'ltr' },
  { code: 'ar', name: 'Arabic', native: 'العربية', dir: 'rtl' },
  { code: 'tr', name: 'Turkish', native: 'Türkçe', dir: 'ltr' },
  { code: 'de', name: 'German', native: 'Deutsch', dir: 'ltr' },
  { code: 'fr', name: 'French', native: 'Français', dir: 'ltr' },
  { code: 'es', name: 'Spanish', native: 'Español', dir: 'ltr' },
  { code: 'it', name: 'Italian', native: 'Italiano', dir: 'ltr' },
  { code: 'pt', name: 'Portuguese', native: 'Português', dir: 'ltr' },
  { code: 'ru', name: 'Russian', native: 'Русский', dir: 'ltr' },
  { code: 'hi', name: 'Hindi', native: 'हिन्दी', dir: 'ltr' },
  { code: 'ur', name: 'Urdu', native: 'اردو', dir: 'rtl' },
  { code: 'ko', name: 'Korean', native: '한국어', dir: 'ltr' },
];

/** Every ISO 639 code for a Chinese language or the Chinese macrolanguage. */
const CHINESE = new Set([
  'zh',
  'zho',
  'chi',
  'cmn',
  'yue',
  'wuu',
  'hak',
  'nan',
  'gan',
  'hsn',
  'cjy',
  'cdo',
  'cpx',
  'czh',
  'czo',
  'mnp',
  'lzh',
  'csp',
  'cnp',
]);

const RTL = new Set(['ar', 'fa', 'he', 'ur', 'ps', 'ckb', 'dv', 'yi', 'sd', 'ug', 'iw']);

function primary(tag: string): string {
  return tag.split(/[-_]/)[0]?.toLowerCase() ?? '';
}

export function isChineseLanguage(tag: string): boolean {
  return CHINESE.has(primary(tag));
}

export function withoutChinese<T>(items: readonly T[], tagOf: (item: T) => string): T[] {
  return items.filter((item) => !isChineseLanguage(tagOf(item)));
}

export function directionOf(tag: string): 'ltr' | 'rtl' {
  return RTL.has(primary(tag)) ? 'rtl' : 'ltr';
}

export function isContentLanguage(code: string): boolean {
  return CONTENT_LANGUAGES.some((l) => l.code === code);
}
