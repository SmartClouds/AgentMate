/**
 * Cheap checks that an answer is written in the language asked for. A model told to write Persian
 * sometimes answers in English, and a repair round fixes that if it is told so. Languages that
 * share the Latin script cannot be told apart this way and are not checked.
 */

const SCRIPTS: Record<string, { name: string; pattern: RegExp }> = {
  fa: { name: 'Persian', pattern: /\p{Script=Arabic}/u },
  ar: { name: 'Arabic', pattern: /\p{Script=Arabic}/u },
  ur: { name: 'Urdu', pattern: /\p{Script=Arabic}/u },
  ru: { name: 'Russian', pattern: /\p{Script=Cyrillic}/u },
  hi: { name: 'Hindi', pattern: /\p{Script=Devanagari}/u },
  ko: { name: 'Korean', pattern: /\p{Script=Hangul}/u },
};

const HAN = /\p{Script=Han}/u;

/** Problems with the language of `texts` (the narration and on-screen lines), worded for a repair. */
export function languageIssues(language: string, texts: string[]): string[] {
  const issues: string[] = [];
  const filled = texts.filter((t) => t.trim().length > 0);
  if (filled.some((t) => HAN.test(t))) {
    issues.push('Do not use Chinese characters anywhere in the answer.');
  }
  const script = SCRIPTS[language.split('-')[0]?.toLowerCase() ?? ''];
  if (script && filled.length > 0) {
    const inScript = filled.filter((t) => script.pattern.test(t)).length;
    if (inScript < filled.length / 2) {
      issues.push(`Write the narration and on-screen text in ${script.name}.`);
    }
  }
  return issues;
}
