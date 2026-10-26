/**
 * LanguageTool is the engine behind Runova's writing checks. Text goes to the
 * public API by default. The desktop distribution the user drops into the app's
 * tools folder speaks the same HTTP contract, so switching to it is only a
 * change of base URL, which is why everything below is shared by both modes.
 */

export const LANGUAGETOOL_TOOL_ID = 'languagetool';
export const LANGUAGETOOL_WEBSITE_URL = 'https://languagetool.org/';
export const LANGUAGETOOL_REPOSITORY_URL = 'https://github.com/languagetool-org/languagetool';
/** The "stable" zip, which is the desktop/server bundle with all the language rules in it. */
export const LANGUAGETOOL_DOWNLOAD_URL =
  'https://languagetool.org/download/LanguageTool-stable.zip';
export const LANGUAGETOOL_ONLINE_BASE_URL = 'https://api.languagetool.org';
export const LANGUAGETOOL_DEFAULT_PORT = 8081;

/** api.languagetool.org rejects a request past this on the free tier. */
export const LANGUAGETOOL_ONLINE_MAX_CHARS = 20000;
/**
 * The local server has no such limit, but checking a whole long document on
 * every keystroke pause is slow enough that it needs one anyway.
 */
export const LANGUAGETOOL_LOCAL_MAX_CHARS = 60000;

/** The jar that carries the HTTP server class, at the root of the extracted zip. */
export const LANGUAGETOOL_SERVER_JAR = 'languagetool-server.jar';

export const GRAMMAR_ISSUE_KINDS = [
  'spelling',
  'grammar',
  'punctuation',
  'typography',
  'style',
  'other',
] as const;
export type GrammarIssueKind = (typeof GRAMMAR_ISSUE_KINDS)[number];

/**
 * LanguageTool labels a match twice: a broad `issueType` and a category id that
 * differs per language pack. Both are consulted because neither is complete,
 * and the result only drives the underline color and the grouping in the
 * writing panel, so an unknown label landing on 'other' is harmless.
 */
export function grammarIssueKindFor(input: {
  issueType?: string | null;
  categoryId?: string | null;
}): GrammarIssueKind {
  const issueType = (input.issueType ?? '').toLowerCase();
  const categoryId = (input.categoryId ?? '').toUpperCase();

  if (categoryId === 'TYPOS' || issueType === 'misspelling') return 'spelling';
  if (categoryId === 'PUNCTUATION') return 'punctuation';
  if (categoryId === 'TYPOGRAPHY' || issueType === 'typographical' || issueType === 'whitespace')
    return 'typography';
  if (
    categoryId === 'STYLE' ||
    categoryId === 'REDUNDANCY' ||
    categoryId === 'PLAIN_ENGLISH' ||
    categoryId === 'CREATIVE_WRITING' ||
    issueType === 'style'
  )
    return 'style';
  if (
    categoryId === 'GRAMMAR' ||
    categoryId === 'CASING' ||
    categoryId === 'CONFUSED_WORDS' ||
    categoryId === 'COMPOUNDING' ||
    categoryId === 'SEMANTICS' ||
    categoryId === 'COLLOCATIONS' ||
    issueType === 'grammar' ||
    issueType === 'duplication' ||
    issueType === 'inconsistency'
  )
    return 'grammar';
  return 'other';
}

/**
 * Whether an issue is a mistake rather than a suggestion. "Fix all" only takes
 * these, since a style rewrite is a matter of taste and should stay a decision.
 */
export function isGrammarMistake(kind: GrammarIssueKind): boolean {
  return kind === 'spelling' || kind === 'grammar' || kind === 'punctuation';
}

export const GRAMMAR_ISSUE_KIND_LABELS: Record<GrammarIssueKind, string> = {
  spelling: 'Spelling',
  grammar: 'Grammar',
  punctuation: 'Punctuation',
  typography: 'Typography',
  style: 'Style',
  other: 'Writing',
};

/** Languages worth offering in Settings; LanguageTool supports more, these are the ones with real rule sets. */
export const GRAMMAR_LANGUAGES: { value: string; label: string }[] = [
  { value: 'auto', label: 'Auto-detect' },
  { value: 'en-US', label: 'English (US)' },
  { value: 'en-GB', label: 'English (UK)' },
  { value: 'de-DE', label: 'German' },
  { value: 'fr-FR', label: 'French' },
  { value: 'es', label: 'Spanish' },
  { value: 'pt-PT', label: 'Portuguese' },
  { value: 'it', label: 'Italian' },
  { value: 'nl', label: 'Dutch' },
  { value: 'ru-RU', label: 'Russian' },
  { value: 'pl-PL', label: 'Polish' },
  { value: 'uk-UA', label: 'Ukrainian' },
  { value: 'ar', label: 'Arabic' },
  { value: 'zh-CN', label: 'Chinese' },
];

/**
 * Mother tongue turns on false-friend rules ("actually" for a German speaker,
 * say). It has to be a language LanguageTool knows, so the list is the one
 * above without the auto entry.
 */
export const GRAMMAR_MOTHER_TONGUES = GRAMMAR_LANGUAGES.filter((entry) => entry.value !== 'auto');

export interface GrammarSettings {
  /** Master switch. Off means no checks, no underlines, and nothing leaves the machine. */
  enabled: boolean;
  /**
   * Underline issues as you type in the larger writing surfaces. Off still
   * leaves the right-click check, which only runs when asked.
   */
  liveCheck: boolean;
  /** 'online' is LanguageTool's public API; 'local' is the server Runova starts from its tools folder. */
  source: 'online' | 'local';
  /** Language code sent with each check, or 'auto' to let LanguageTool detect it per field. */
  language: string;
  /** Native language, for false-friend rules. Null leaves them off. */
  motherTongue: string | null;
  /** Include style and typography suggestions, not just mistakes (LanguageTool's "picky" level). */
  picky: boolean;
  /** Port the local server listens on. */
  localPort: number;
  /** Rule ids the user chose to stop hearing about, e.g. "OXFORD_SPELLING_Z_NOT_S". */
  ignoredRules: string[];
}

export function defaultGrammarSettings(): GrammarSettings {
  return {
    enabled: true,
    liveCheck: true,
    source: 'online',
    language: 'auto',
    motherTongue: null,
    picky: false,
    localPort: LANGUAGETOOL_DEFAULT_PORT,
    ignoredRules: [],
  };
}

/**
 * settings.json is hand-editable and can come from an older build, so every
 * field is checked before either process reads it. A bad port or an unknown
 * source would otherwise surface as a failed check with no explanation.
 */
export function normalizeGrammarSettings(
  value: Partial<GrammarSettings> | null | undefined,
): GrammarSettings {
  const defaults = defaultGrammarSettings();
  if (!value || typeof value !== 'object') return defaults;
  const port = Number(value.localPort);
  return {
    enabled: value.enabled !== false,
    liveCheck: value.liveCheck !== false,
    source: value.source === 'local' ? 'local' : 'online',
    language: typeof value.language === 'string' && value.language ? value.language : 'auto',
    motherTongue:
      typeof value.motherTongue === 'string' && value.motherTongue ? value.motherTongue : null,
    picky: value.picky === true,
    localPort: Number.isInteger(port) && port >= 1024 && port <= 65535 ? port : defaults.localPort,
    ignoredRules: Array.isArray(value.ignoredRules)
      ? [...new Set(value.ignoredRules.filter((rule): rule is string => typeof rule === 'string'))]
      : [],
  };
}
