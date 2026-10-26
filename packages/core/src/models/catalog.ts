/**
 * Every AI model name Runova knows, in one file.
 *
 * When a provider ships a new model (or renames one), this is the only file to edit. The rest of
 * the app reads from here: the run recommendation in Prompt Builder, launch defaults in Settings,
 * CLI argument hints, Ask AI's model pickers, the Diffray wizard, token cost estimates, and the
 * labels on usage windows.
 *
 * Each entry keeps the three names a model goes by apart:
 * - `label` is what people read ("Opus 5.5").
 * - `cliArg` is what goes after the CLI's model flag ("opus").
 * - `apiId` is the id the provider's API and logs use ("claude-opus-5-5"). Cost estimates match it
 *   against MODEL_PRICES by prefix.
 *
 * This file imports nothing, so any module can read it without an import cycle.
 */

export interface CatalogModel {
  /** What people read, e.g. "Opus 5.5". */
  label: string;
  /** Model family without the version, e.g. "Opus". */
  family?: string;
  /** Value for the CLI's model flag, e.g. "opus". */
  cliArg?: string;
  /** Id the provider's API and logs use, e.g. "claude-opus-5-5". */
  apiId?: string;
}

/** A model offered in a simple picker, where the value is the id sent as is. */
export interface CatalogModelOption {
  value: string;
  label: string;
}

// Anthropic (Claude Code and anything else that takes Claude aliases)

export const CLAUDE_MODELS = {
  haiku: { label: 'Haiku 5.5', family: 'Haiku', cliArg: 'haiku', apiId: 'claude-haiku-5-5' },
  sonnet: { label: 'Sonnet 5.5', family: 'Sonnet', cliArg: 'sonnet', apiId: 'claude-sonnet-5-5' },
  opus: { label: 'Opus 5.5', family: 'Opus', cliArg: 'opus', apiId: 'claude-opus-5-5' },
  fable: { label: 'Fable 5.1', family: 'Fable', cliArg: 'fable', apiId: 'claude-fable-5-1' },
} as const satisfies Record<string, CatalogModel>;

/** Claude family names, e.g. for reading "Set model to Opus 5.5" out of a transcript. */
export const CLAUDE_FAMILIES: readonly string[] = Object.values(CLAUDE_MODELS).map((m) => m.family);

/**
 * The Claude model that plans above Pro meter in a weekly bucket of its own. It moved from Opus
 * to Fable once already. The stored window key stays 'week-fable' either way.
 */
export const CLAUDE_WEEKLY_METERED_MODEL = CLAUDE_MODELS.fable;

// OpenAI (Codex CLI)

export const CODEX_MODELS = {
  luna: { label: 'GPT-6 Luna', cliArg: 'gpt-6-luna', apiId: 'gpt-6-luna' },
  sol: { label: 'GPT-6.1 Sol', cliArg: 'gpt-6.1-sol', apiId: 'gpt-6.1-sol' },
  astra: { label: 'GPT-6 Astra', cliArg: 'gpt-6-astra', apiId: 'gpt-6-astra' },
} as const satisfies Record<string, CatalogModel>;

/** Priced in place of a Codex log entry that never said which model it came from. */
export const CODEX_LOG_FALLBACK_MODEL = 'gpt-5';

/** Priced in place of Copilot usage that never named a model (CLI logs without one, API rollups). */
export const COPILOT_LOG_FALLBACK_MODEL = 'gpt-5';

/** Priced in place of an OpenCode session row that never named a model. */
export const OPENCODE_LOG_FALLBACK_MODEL = 'gpt-5';

/** Priced in place of a Gemini CLI log entry that never said which model it came from. */
export const GEMINI_LOG_FALLBACK_MODEL = 'gemini-2.5-flash';

// Google (Gemini CLI)

export const GEMINI_CLI_MODELS = {
  flashLite: {
    label: 'Gemini 3.5 Flash-Lite',
    cliArg: 'gemini-3.5-flash-lite',
    apiId: 'gemini-3.5-flash-lite',
  },
  flash: { label: 'Gemini 3.8 Flash', cliArg: 'gemini-3.8-flash', apiId: 'gemini-3.8-flash' },
  pro: {
    label: 'Gemini 3.1 Pro',
    cliArg: 'gemini-3.1-pro-preview',
    apiId: 'gemini-3.1-pro-preview',
  },
  argon: { label: 'Gemini 4 Argon', cliArg: 'gemini-4-argon', apiId: 'gemini-4-argon' },
} as const satisfies Record<string, CatalogModel>;

// xAI (Grok CLI). Newest first. The ids are the ones xAI's model table lists, and MODEL_PRICES
// prices them by prefix.

export const GROK_MODELS = {
  g47: { label: 'Grok 4.7', cliArg: 'grok-4.7', apiId: 'grok-4.7' },
  g46: { label: 'Grok 4.6', cliArg: 'grok-4.6', apiId: 'grok-4.6' },
  g45: { label: 'Grok 4.5', cliArg: 'grok-4.5', apiId: 'grok-4.5' },
  g43: { label: 'Grok 4.3', cliArg: 'grok-4.3', apiId: 'grok-4.3' },
  g420: {
    label: 'Grok 4.20',
    cliArg: 'grok-4.20-0309-reasoning',
    apiId: 'grok-4.20-0309-reasoning',
  },
  build: { label: 'Grok Build 0.1', cliArg: 'grok-build-0.1', apiId: 'grok-build-0.1' },
} as const satisfies Record<string, CatalogModel>;

// Cursor CLI. `auto` lets Cursor pick the model itself. Every other id is one that
// `cursor-agent --list-models` prints, and it carries its own effort ("-high"), so the label says
// which one it is. Any other id from that list can be typed in by hand.

export const CURSOR_MODELS = {
  auto: { label: 'Auto', cliArg: 'auto' },
  composer: { label: 'Composer 2.5', cliArg: 'composer-2.5' },
  fable: { label: 'Fable 5.1 (high)', cliArg: 'claude-fable-5-1-high' },
  opus: { label: 'Opus 5.5 (high)', cliArg: 'claude-opus-5-5-high' },
  sonnet: { label: 'Sonnet 5.5 (high)', cliArg: 'claude-sonnet-5-5-high' },
  haiku: { label: 'Haiku 5.5 (high)', cliArg: 'claude-haiku-5-5-thinking-high' },
  sol: { label: 'GPT-5.6 Sol (high)', cliArg: 'gpt-5.6-sol-high' },
  argon: { label: 'Gemini 4 Argon (high)', cliArg: 'gemini-4-argon-high' },
  flash: { label: 'Gemini 3.8 Flash (high)', cliArg: 'gemini-3.8-flash-high' },
  grok: { label: 'Grok 4.7 (high)', cliArg: 'grok-4.7-high' },
} as const satisfies Record<string, CatalogModel>;

// Example model names shown as argument hints, per CLI id. Only the model goes here. The flag
// stays with the CLI in cli/registry.ts, since each CLI spells it differently.

export const CLI_MODEL_EXAMPLES = {
  'claude-code': CLAUDE_MODELS.sonnet.cliArg,
  openclaude: CLAUDE_MODELS.sonnet.cliArg,
  aider: CLAUDE_MODELS.sonnet.cliArg,
  pi: CLAUDE_MODELS.sonnet.cliArg,
  'gemini-cli': GEMINI_CLI_MODELS.pro.cliArg,
  opencode: `anthropic/${CLAUDE_MODELS.sonnet.apiId}`,
  'codex-cli': CODEX_MODELS.sol.cliArg,
  'grok-cli': GROK_MODELS.g47.cliArg,
  'cursor-cli': CURSOR_MODELS.sonnet.cliArg,
  'copilot-cli': CLAUDE_MODELS.sonnet.apiId,
  'qwen-cli': 'qwen3-coder-plus',
  'cline-cli': CLAUDE_MODELS.sonnet.apiId,
  'continue-cli': 'owner/package',
  'muse-code': 'muse-spark-1.2',
} as const;

// Ask AI (direct API calls)

export const OPENAI_API_MODELS: readonly CatalogModelOption[] = [
  { value: CODEX_MODELS.luna.apiId, label: CODEX_MODELS.luna.apiId },
  { value: CODEX_MODELS.sol.apiId, label: CODEX_MODELS.sol.apiId },
  { value: CODEX_MODELS.astra.apiId, label: CODEX_MODELS.astra.apiId },
];
export const DEFAULT_OPENAI_API_MODEL = CODEX_MODELS.luna.apiId;

export const GEMINI_API_MODELS: readonly CatalogModelOption[] = [
  { value: GEMINI_CLI_MODELS.flash.apiId, label: GEMINI_CLI_MODELS.flash.apiId },
  { value: GEMINI_CLI_MODELS.flashLite.apiId, label: GEMINI_CLI_MODELS.flashLite.apiId },
  { value: GEMINI_CLI_MODELS.pro.apiId, label: GEMINI_CLI_MODELS.pro.apiId },
  { value: GEMINI_CLI_MODELS.argon.apiId, label: GEMINI_CLI_MODELS.argon.apiId },
];
/** Google points new projects at Flash. Gemini 2.x is closed to new users. */
export const DEFAULT_GEMINI_API_MODEL = GEMINI_CLI_MODELS.flash.apiId;

// Help chat (embeddings for the Help articles' search index)

export interface EmbeddingModel {
  id: string;
  /** The vector size the index asks for. Gemini can return fewer than its native size. */
  dimensions: number;
}

/**
 * The embedding model the help chat uses with each API provider. Ollama's has to be pulled
 * (`ollama pull nomic-embed-text`); without it the chat still answers from keyword search.
 */
export const HELP_EMBEDDING_MODELS = {
  openai: { id: 'text-embedding-3-small', dimensions: 1536 },
  gemini: { id: 'gemini-embedding-001', dimensions: 768 },
  ollama: { id: 'nomic-embed-text', dimensions: 768 },
} as const satisfies Record<'openai' | 'gemini' | 'ollama', EmbeddingModel>;

type EmbeddingProvider = keyof typeof HELP_EMBEDDING_MODELS;

/**
 * Embedding models offered in Settings for the help chat's search, default first. Ollama's list
 * is only a starting point: the picker also shows the embedding models installed on the server,
 * and any model name can be typed in.
 */
export const HELP_EMBEDDING_MODEL_OPTIONS: Record<
  EmbeddingProvider,
  readonly CatalogModelOption[]
> = {
  openai: [
    { value: 'text-embedding-3-small', label: 'text-embedding-3-small (fast, low cost)' },
    { value: 'text-embedding-3-large', label: 'text-embedding-3-large (most accurate)' },
  ],
  gemini: [{ value: 'gemini-embedding-001', label: 'gemini-embedding-001' }],
  ollama: [
    { value: 'nomic-embed-text', label: 'nomic-embed-text (English)' },
    { value: 'nomic-embed-text-v2-moe', label: 'nomic-embed-text-v2-moe (multilingual)' },
    { value: 'bge-m3', label: 'bge-m3 (multilingual)' },
    { value: 'mxbai-embed-large', label: 'mxbai-embed-large (English)' },
  ],
};

/** The embedding model the help chat uses with `provider`: the one picked in Settings, or the default. */
export function helpEmbeddingModel(
  provider: EmbeddingProvider,
  picked: Partial<Record<string, string>> | null | undefined,
): string {
  return picked?.[provider]?.trim() || HELP_EMBEDDING_MODELS[provider].id;
}

/** Keeps only non-empty model names for known providers, so a bad settings file cannot break search. */
export function normalizeHelpEmbeddingModels(
  value: unknown,
): Partial<Record<EmbeddingProvider, string>> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
  const out: Partial<Record<EmbeddingProvider, string>> = {};
  for (const provider of Object.keys(HELP_EMBEDDING_MODELS) as EmbeddingProvider[]) {
    const model = (value as Record<string, unknown>)[provider];
    if (typeof model === 'string' && model.trim()) out[provider] = model.trim().slice(0, 200);
  }
  return out;
}

// Tools

/** Strix takes one model in provider/model form. */
export const STRIX_DEFAULT_MODEL = `anthropic/${CLAUDE_MODELS.sonnet.apiId}`;

/** Commented-out example in the generated .codex/config.toml. */
export const CODEX_CONFIG_EXAMPLE_MODEL = CLI_MODEL_EXAMPLES['codex-cli'];

/** Models Diffray accepts, per executor. An empty value leaves it to the executor. */
export const DIFFRAY_EXECUTOR_MODELS = {
  'claude-cli': [
    { value: CLAUDE_MODELS.haiku.cliArg, label: `${CLAUDE_MODELS.haiku.family} (fast)` },
    { value: CLAUDE_MODELS.sonnet.cliArg, label: `${CLAUDE_MODELS.sonnet.family} (balanced)` },
    { value: CLAUDE_MODELS.opus.cliArg, label: `${CLAUDE_MODELS.opus.family} (thorough)` },
  ],
  'cursor-agent-cli': Object.values(CURSOR_MODELS).map((m) => ({
    value: m.cliArg,
    label: m.label,
  })),
  'opencode-cli': [
    { value: 'opencode/gpt-5-nano', label: 'GPT-5 nano' },
    { value: 'opencode/grok-code', label: 'Grok code' },
  ],
  'codex-cli': [],
} as const satisfies Record<string, readonly CatalogModelOption[]>;

/** Model names as Diffray's docs write them in its speed vs quality table. */
export const DIFFRAY_DOC_MODELS = {
  haiku: CLAUDE_MODELS.haiku.cliArg,
  sonnet: CLAUDE_MODELS.sonnet.cliArg,
  opus: CLAUDE_MODELS.opus.cliArg,
  codex: CODEX_MODELS.sol.cliArg,
  opencodeNano: 'opencode/gpt-5-nano',
} as const;

// Local speech (voice input)

export interface WhisperModel {
  /** Key stored in settings. */
  key: string;
  label: string;
  /** Hugging Face repo with the ONNX weights. */
  hubId: string;
  /**
   * Which weight files transformers.js loads. Unset means full precision, which is fine for the
   * small models but over 3 GB for the large one. Its 4-bit weights transcribe Persian almost
   * word for word, while its 8-bit ones fall into repeating one word forever, so pick by testing.
   */
  dtype?: string;
}

export const WHISPER_MODEL_LARGE_TURBO = 'large-v3-turbo';

export const WHISPER_MODELS: readonly WhisperModel[] = [
  { key: 'tiny', label: 'Tiny (fastest, ~75 MB)', hubId: 'onnx-community/whisper-tiny' },
  { key: 'base', label: 'Base (balanced, ~145 MB)', hubId: 'onnx-community/whisper-base' },
  { key: 'small', label: 'Small (~490 MB)', hubId: 'onnx-community/whisper-small' },
  {
    key: WHISPER_MODEL_LARGE_TURBO,
    label: 'Large v3 Turbo (most accurate, best for Persian, ~760 MB)',
    hubId: 'onnx-community/whisper-large-v3-turbo',
    dtype: 'q4',
  },
];
/** `base` is the accuracy and size sweet spot for short English dictation. */
export const DEFAULT_WHISPER_MODEL = 'base';

export interface SpeechLanguage {
  /** Whisper language code. */
  code: string;
  label: string;
  /**
   * The smallest model that transcribes this language well enough to use. The smaller models
   * write Persian as a jumble of half-right words, so the settings and the mic say so.
   */
  recommendedModel?: string;
}

export const SPEECH_LANGUAGES: readonly SpeechLanguage[] = [
  { code: 'en', label: 'English' },
  { code: 'fa', label: 'Persian (فارسی)', recommendedModel: WHISPER_MODEL_LARGE_TURBO },
  { code: 'es', label: 'Spanish' },
  { code: 'fr', label: 'French' },
  { code: 'de', label: 'German' },
  { code: 'ar', label: 'Arabic' },
  { code: 'zh', label: 'Chinese' },
  { code: 'ru', label: 'Russian' },
  { code: 'hi', label: 'Hindi' },
  { code: 'tr', label: 'Turkish' },
];

/**
 * The language Whisper is told it is hearing. The local Whisper runtime cannot detect a language
 * (it quietly assumes English, which turns Persian speech into made-up English), so a stored
 * "auto" from older versions, or anything unknown, becomes the system language when it is one of
 * ours, else English.
 */
export function resolveSpeechLanguage(stored: string | undefined, systemLocale = ''): string {
  const known = (code: string) => SPEECH_LANGUAGES.some((lang) => lang.code === code);
  if (stored && known(stored)) return stored;
  const system = systemLocale.toLowerCase().split(/[-_]/)[0] ?? '';
  return known(system) ? system : 'en';
}

/** True when `modelKey` is too small to understand `languageCode` well. */
export function speechModelTooSmallFor(modelKey: string, languageCode: string): boolean {
  const wanted = SPEECH_LANGUAGES.find((lang) => lang.code === languageCode)?.recommendedModel;
  if (!wanted) return false;
  const rank = (key: string) => WHISPER_MODELS.findIndex((m) => m.key === key);
  return rank(modelKey) < rank(wanted);
}

// Studio narration (text to speech)

export interface StudioTtsVoice {
  /** The id the provider's API takes. */
  id: string;
  label: string;
  /** BCP 47 locale for a voice made for one language; unset for voices that speak any. */
  locale?: string;
  gender?: 'female' | 'male';
}

export interface StudioTtsEngine {
  label: string;
  /** The model id sent with every request; unset where the voice alone decides. */
  model?: string;
  /** When the provider retires the model, so the app can say so ahead of time. */
  retiresOn?: string;
  voices: readonly StudioTtsVoice[];
  /**
   * List price in USD per 1,000,000 characters of text, for an estimate before speaking. Null
   * where the provider bills otherwise (by token, or from a subscription's credits).
   */
  pricePerMillionChars: number | null;
}

const OPENAI_TTS_VOICES = [
  'alloy',
  'ash',
  'ballad',
  'coral',
  'echo',
  'fable',
  'nova',
  'onyx',
  'sage',
  'shimmer',
  'verse',
  'marin',
  'cedar',
].map((id) => ({ id, label: id[0]?.toUpperCase() + id.slice(1) }));

const GEMINI_TTS_VOICES = [
  'Zephyr',
  'Puck',
  'Charon',
  'Kore',
  'Fenrir',
  'Leda',
  'Orus',
  'Aoede',
  'Callirrhoe',
  'Autonoe',
  'Enceladus',
  'Iapetus',
  'Umbriel',
  'Algieba',
  'Despina',
  'Erinome',
  'Algenib',
  'Rasalgethi',
  'Laomedeia',
  'Achernar',
  'Alnilam',
  'Schedar',
  'Gacrux',
  'Pulcherrima',
  'Achird',
  'Zubenelgenubi',
  'Vindemiatrix',
  'Sadachbia',
  'Sadaltager',
  'Sulafat',
].map((id) => ({ id, label: id }));

/**
 * The voice engines Studio narrates with, as their docs stood in October 2026. OpenAI's voices
 * and Gemini's speak any language (both list Persian); ElevenLabs voices come from the user's own
 * account, and only its v3 model speaks Persian; Azure voices are one per locale, and these are the
 * ones for the languages Studio writes in.
 */
export const STUDIO_TTS: Record<'openai' | 'gemini' | 'elevenlabs' | 'azure', StudioTtsEngine> = {
  openai: {
    label: 'OpenAI',
    model: 'gpt-4o-mini-tts',
    retiresOn: '2027-01-06',
    voices: OPENAI_TTS_VOICES,
    pricePerMillionChars: 15,
  },
  gemini: {
    label: 'Google Gemini',
    model: 'gemini-3.8-flash-tts',
    voices: GEMINI_TTS_VOICES,
    pricePerMillionChars: null,
  },
  elevenlabs: {
    label: 'ElevenLabs',
    model: 'eleven_v3',
    voices: [],
    pricePerMillionChars: null,
  },
  azure: {
    label: 'Azure Speech',
    voices: [
      { id: 'fa-IR-DilaraNeural', label: 'Dilara', locale: 'fa-IR', gender: 'female' },
      { id: 'fa-IR-FaridNeural', label: 'Farid', locale: 'fa-IR', gender: 'male' },
      { id: 'en-US-AvaMultilingualNeural', label: 'Ava', locale: 'en-US', gender: 'female' },
      { id: 'en-US-JennyNeural', label: 'Jenny', locale: 'en-US', gender: 'female' },
      { id: 'en-US-GuyNeural', label: 'Guy', locale: 'en-US', gender: 'male' },
      { id: 'en-GB-SoniaNeural', label: 'Sonia', locale: 'en-GB', gender: 'female' },
      { id: 'ar-SA-ZariyahNeural', label: 'Zariyah', locale: 'ar-SA', gender: 'female' },
      { id: 'ar-SA-HamedNeural', label: 'Hamed', locale: 'ar-SA', gender: 'male' },
      { id: 'tr-TR-EmelNeural', label: 'Emel', locale: 'tr-TR', gender: 'female' },
      { id: 'de-DE-KatjaNeural', label: 'Katja', locale: 'de-DE', gender: 'female' },
      { id: 'fr-FR-DeniseNeural', label: 'Denise', locale: 'fr-FR', gender: 'female' },
      { id: 'es-ES-ElviraNeural', label: 'Elvira', locale: 'es-ES', gender: 'female' },
    ],
    pricePerMillionChars: 16,
  },
};

/** One file a local voice engine needs, pinned by its hash so a download is checked exactly. */
export interface StudioModelFile {
  /** Where it goes under the engine's model folder (forward slashes). */
  path: string;
  url: string;
  size: number;
  sha256: string;
}

export interface StudioLocalVoice extends StudioTtsVoice {
  locale: string;
  /** The voice's own license, from its model card. */
  license: string;
  /** Usable for non-commercial work only, which Studio says wherever the voice is offered. */
  nonCommercial: boolean;
  files: readonly StudioModelFile[];
}

const PIPER_VOICES_AT =
  'https://huggingface.co/rhasspy/piper-voices/resolve/5041a7a49ae5b3a0f30e6837769eb03fdbb231bd';

function piperVoice(
  voice: Omit<StudioLocalVoice, 'files'>,
  folder: string,
  onnx: { size: number; sha256: string },
  config: { size: number; sha256: string },
): StudioLocalVoice {
  const name = voice.id;
  return {
    ...voice,
    files: [
      { path: `${name}.onnx`, url: `${PIPER_VOICES_AT}/${folder}/${name}.onnx`, ...onnx },
      {
        path: `${name}.onnx.json`,
        url: `${PIPER_VOICES_AT}/${folder}/${name}.onnx.json`,
        ...config,
      },
    ],
  };
}

/**
 * Piper (piper-tts, GPL-3.0, installed by Dev Setup into Studio's own Python) and the voices
 * Studio offers with it. The Persian voices are CC0; Piper's English voices are almost all
 * non-commercial, and the one here is marked so.
 */
export const STUDIO_PIPER = {
  label: 'Piper',
  license: 'GPL-3.0-or-later',
  voices: [
    piperVoice(
      {
        id: 'fa_IR-amir-medium',
        label: 'Amir',
        locale: 'fa-IR',
        gender: 'male',
        license: 'CC0',
        nonCommercial: false,
      },
      'fa/fa_IR/amir/medium',
      {
        size: 63_531_379,
        sha256: 'fb815380d969ea372b0b21b0de14421f58fe481047e153e69685d079b6e1a9d1',
      },
      { size: 4958, sha256: '75f918a3bf0f57a9179abe725af529f2a5c79d6c899e2a84aec76c685d5dfb9a' },
    ),
    piperVoice(
      {
        id: 'fa_IR-ganji-medium',
        label: 'Ganji',
        locale: 'fa-IR',
        gender: 'male',
        license: 'CC0',
        nonCommercial: false,
      },
      'fa/fa_IR/ganji/medium',
      {
        size: 63_516_050,
        sha256: '6a98504bb77dc2fd3a863c977d37e67a6a525fdf661917385d569a3ff78e6cae',
      },
      { size: 4958, sha256: '9d3e0c0cf00156d8bf38fb7f96bdfbcb21911b37e062a328da0632e3c2cbc465' },
    ),
    piperVoice(
      {
        id: 'fa_IR-reza_ibrahim-medium',
        label: 'Reza Ibrahim',
        locale: 'fa-IR',
        gender: 'male',
        license: 'CC0',
        nonCommercial: false,
      },
      'fa/fa_IR/reza_ibrahim/medium',
      {
        size: 63_511_038,
        sha256: '99f0c31464a2120831ca87d079e10a9a2b3e426cc1ee662d80ff9042df15cd3c',
      },
      { size: 4967, sha256: 'e9866c88c16245f8b8f4d0eaeaa6eab4f2e193db69a2ab4683d83fe78a30b6ca' },
    ),
    piperVoice(
      {
        id: 'en_US-hfc_female-medium',
        label: 'HFC Female',
        locale: 'en-US',
        gender: 'female',
        license: 'CC BY-NC-SA 4.0',
        nonCommercial: true,
      },
      'en/en_US/hfc_female/medium',
      {
        size: 63_201_294,
        sha256: '914c473788fc1fa8b63ace1cdcdb44588f4ae523d3ab37df1536616835a140b7',
      },
      { size: 5033, sha256: '03f1fa0622b80463283592d97aca9f6e89aec345a5c56b7257723e0093c58b6c' },
    ),
  ] as readonly StudioLocalVoice[],
} as const;

const OMNIVOICE_AT =
  'https://huggingface.co/k2-fsa/OmniVoice/resolve/c5fdb5ccb189668d56333f77ba2629f4cd7535f4';

/**
 * OmniVoice (Xiaomi Next-gen Kaldi): an optional local engine that clones a voice from a few
 * seconds of speech. Its code is Apache-2.0, but its weights are CC BY-NC 4.0 because of their
 * training data, so everything spoken with it is for non-commercial use only. It speaks at 24 kHz.
 */
export const STUDIO_OMNIVOICE = {
  label: 'OmniVoice',
  weightsLicense: 'CC BY-NC 4.0',
  licenseUrl: 'https://huggingface.co/k2-fsa/OmniVoice',
  sampleRate: 24_000,
  /** Shortest and longest reference recording it clones well from. */
  referenceSeconds: { min: 3, max: 10 },
  files: [
    {
      path: 'config.json',
      size: 2238,
      sha256: '5e359117e13b420c5e0c925d4aba650d624767131f1d1746928f8b850d5dc372',
    },
    {
      path: 'chat_template.jinja',
      size: 4168,
      sha256: 'a55ee1b1660128b7098723e0abcd92caa0788061051c62d51cbe87d9cf1974d8',
    },
    {
      path: 'tokenizer_config.json',
      size: 533,
      sha256: '49f78845596a82bf15c83673794bdf9f76f812b11f60ab6a2239d9be65b00676',
    },
    {
      path: 'tokenizer.json',
      size: 11_423_986,
      sha256: '408f669b7e2b045fdf54201d815bd364e6667dbd845115da81239c40bc6dcfd1',
    },
    {
      path: 'model.safetensors',
      size: 2_450_344_112,
      sha256: '730839316de585f4c8298ec0e1712efc10fb19c6fa4e36eb741cb8d51ebcf6aa',
    },
    {
      path: 'audio_tokenizer/config.json',
      size: 2531,
      sha256: 'eefb20806f7104e77c9a5277c9df0f9bb8826b08eb1d4e8ab2b9829b6ef9fac1',
    },
    {
      path: 'audio_tokenizer/preprocessor_config.json',
      size: 206,
      sha256: 'ae61eea88558608ee2fa86d2aec9fce8d99a5ff75d09cb7651ccce21ae1d9084',
    },
    {
      path: 'audio_tokenizer/model.safetensors',
      size: 805_665_628,
      sha256: 'fe7c5e8785e0a05833e1bfc3e002ec7f55af21e306b2e7154a448c1f54ccfb0d',
    },
  ].map((file) => ({ ...file, url: `${OMNIVOICE_AT}/${file.path}` })) as readonly StudioModelFile[],
} as const;

/**
 * Studio's generated pictures and clips (E38), as the providers' docs and price pages stood in
 * October 2026. Veo 3.1's preview models were shut down on the Gemini API, which now makes video
 * with Gemini Omni Flash; OpenAI's Sora API was shut down on 2026-09-24.
 */
export const STUDIO_GEN = {
  image: {
    openai: {
      label: 'OpenAI',
      model: 'gpt-image-2.5-flare',
      sizes: ['1024x1024', '1536x1024', '1024x1536'] as const,
      qualities: ['low', 'medium', 'high'] as const,
      /**
       * OpenAI prices GPT Image 2.5 by token ($30 per 1M image output tokens) and publishes
       * per-image figures only for GPT Image 2, so these are those figures, used as an estimate.
       * The largest size's figure is used for every size.
       */
      estimatePerImage: { low: 0.006, medium: 0.053, high: 0.211 },
    },
    gemini: {
      label: 'Google Gemini',
      model: 'gemini-nano-banana-2.1',
      sizes: ['1K', '2K', '4K'] as const,
      aspectRatios: ['1:1', '3:2', '2:3', '3:4', '4:3', '4:5', '5:4', '9:16', '16:9'] as const,
      pricePerImage: { '1K': 0.0336, '2K': 0.0504, '4K': 0.113 },
    },
  },
  video: {
    gemini: {
      label: 'Google Gemini Omni',
      model: 'gemini-omni-1.1-flash',
      aspectRatios: ['16:9', '9:16'] as const,
      /** At 720p, the resolution it makes (1080p and 4K are upscaled from it). */
      pricePerSecond: 0.1,
      /** The model picks a clip's length; this is what an estimate assumes. */
      expectedSeconds: 8,
    },
  },
} as const;

// Prices

export interface ModelPrice {
  input: number;
  output: number;
  /** Price of reading a cached input token (usually a fraction of `input`). */
  cacheRead: number;
  /** Price of writing/creating a cache entry (usually a premium over `input`). */
  cacheWrite: number;
}

/**
 * Hand-maintained subset of model pricing (USD per 1,000,000 tokens), in the spirit of LiteLLM's
 * price map. Keys are matched by longest prefix against the model id, so dated variants
 * ("claude-sonnet-5-5-20260101") fall through to their base entry. Older ids stay listed because
 * past logs still name them.
 */
export const MODEL_PRICES: Record<string, ModelPrice> = {
  // Anthropic (Claude). Cache read is a tenth of the input rate; cache write carries a 1.25×
  // premium (the 5-minute TTL, which is what the CLIs use). Opus dropped from $15/$75 to $5/$25
  // at 4.5, so the newer Opus ids need their own entries; longest-prefix keeps 4.0/4.1 on the
  // old rate. Opus 5.5 is cheaper again, and its cache reads are 5% of input rather than 10%.
  // Fable 5.1 (and Mythos 5.1) keep Fable 5's rates but cut cache reads to $0.25. Sonnet dropped
  // to $2/$10 at 5, with cache reads at $0.20. Haiku 5.5 is $0.10/$0.50 for prompts up to 100k
  // tokens (longer ones cost $0.50/$2.50, which this flat table doesn't model).
  'claude-fable-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-fable-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-mythos-5-1': { input: 10, output: 50, cacheRead: 0.25, cacheWrite: 12.5 },
  'claude-mythos-5': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'claude-opus-5-5': { input: 4, output: 20, cacheRead: 0.2, cacheWrite: 5 },
  'claude-opus-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-8': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-7': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-6': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4-5': { input: 5, output: 25, cacheRead: 0.5, cacheWrite: 6.25 },
  'claude-opus-4': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },
  'claude-sonnet-4': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-sonnet-5-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-sonnet-5': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'claude-haiku-5-5': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'claude-haiku-4': { input: 1, output: 5, cacheRead: 0.1, cacheWrite: 1.25 },
  'claude-3-5-sonnet': { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 3.75 },
  'claude-3-5-haiku': { input: 0.8, output: 4, cacheRead: 0.08, cacheWrite: 1 },
  'claude-3-opus': { input: 15, output: 75, cacheRead: 1.5, cacheWrite: 18.75 },

  // OpenAI (GPT / o-series / Codex). Rates for prompts under about 272k tokens; longer ones
  // cost 2x on input and 1.5x on output. GPT-6 and GPT-5.6 cache writes carry a 1.25x premium;
  // older models list no write price, so it's billed as plain input. GPT-5.6 Sol's rate is a
  // promotional one that runs through 2026-11-21.
  'gpt-6-astra': { input: 10, output: 50, cacheRead: 1, cacheWrite: 12.5 },
  'gpt-6.1-sol': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2.5 },
  'gpt-6-sol': { input: 2, output: 10, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-6-luna': { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
  'gpt-5.6-sol': { input: 4, output: 20, cacheRead: 0.4, cacheWrite: 5 },
  'gpt-5.6-terra': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2.5 },
  'gpt-5.6-luna': { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
  'gpt-5.5-pro': { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 },
  'gpt-5.5': { input: 5, output: 30, cacheRead: 0.5, cacheWrite: 5 },
  'gpt-5.4-pro': { input: 30, output: 180, cacheRead: 30, cacheWrite: 30 },
  'gpt-5.4-mini': { input: 0.75, output: 4.5, cacheRead: 0.075, cacheWrite: 0.75 },
  'gpt-5.4-nano': { input: 0.2, output: 1.25, cacheRead: 0.02, cacheWrite: 0.2 },
  'gpt-5.4': { input: 2.5, output: 15, cacheRead: 0.25, cacheWrite: 2.5 },
  'gpt-5.3-codex': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5.2': { input: 1.75, output: 14, cacheRead: 0.175, cacheWrite: 1.75 },
  'gpt-5-mini': { input: 0.25, output: 2, cacheRead: 0.025, cacheWrite: 0.25 },
  'gpt-5-nano': { input: 0.05, output: 0.4, cacheRead: 0.005, cacheWrite: 0.05 },
  'gpt-5': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gpt-4.1': { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  'gpt-4o-mini': { input: 0.15, output: 0.6, cacheRead: 0.075, cacheWrite: 0.15 },
  'gpt-4o': { input: 2.5, output: 10, cacheRead: 1.25, cacheWrite: 2.5 },
  'o4-mini': { input: 1.1, output: 4.4, cacheRead: 0.275, cacheWrite: 1.1 },
  o3: { input: 2, output: 8, cacheRead: 0.5, cacheWrite: 2 },
  'codex-mini': { input: 1.5, output: 6, cacheRead: 0.375, cacheWrite: 1.5 },

  // Google (Gemini). Rates for prompts up to 200k tokens (3.1 Pro and 2.5 Pro cost more beyond
  // that). The 3.8 and 3.6 Flash rates are introductory and double on 2027-01-01, and Gemini 4
  // Argon's launch rate doubles on 2026-12-01. The flash-lite entries have to stay: pricing
  // matches by prefix, so without them those ids would fall through to the Flash rate.
  'gemini-4-argon': { input: 2, output: 10, cacheRead: 0.1, cacheWrite: 2 },
  'gemini-3.8-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-3.6-flash': { input: 0.75, output: 3.75, cacheRead: 0.075, cacheWrite: 0.75 },
  'gemini-3.5-flash-lite': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-3.1-pro': { input: 2, output: 12, cacheRead: 0.2, cacheWrite: 2 },
  'gemini-3.1-flash-lite': { input: 0.25, output: 1.5, cacheRead: 0.025, cacheWrite: 0.25 },
  'gemini-2.5-pro': { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 1.25 },
  'gemini-2.5-flash-lite': { input: 0.1, output: 0.4, cacheRead: 0.01, cacheWrite: 0.1 },
  'gemini-2.5-flash': { input: 0.3, output: 2.5, cacheRead: 0.03, cacheWrite: 0.3 },
  'gemini-2.0-flash': { input: 0.1, output: 0.4, cacheRead: 0.025, cacheWrite: 0.1 },

  // xAI (Grok). Rates for prompts under 200k tokens; longer ones cost double.
  'grok-4.7': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  'grok-4.6': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
  'grok-4.5': { input: 2, output: 6, cacheRead: 0.3, cacheWrite: 2 },
  'grok-4.3': { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  'grok-4.20': { input: 1.25, output: 2.5, cacheRead: 0.2, cacheWrite: 1.25 },
  'grok-build': { input: 1, output: 2, cacheRead: 0.2, cacheWrite: 1 },

  // Others.
  'deepseek-chat': { input: 0.27, output: 1.1, cacheRead: 0.07, cacheWrite: 0.27 },
  'deepseek-reasoner': { input: 0.55, output: 2.19, cacheRead: 0.14, cacheWrite: 0.55 },
  'mistral-large': { input: 2, output: 6, cacheRead: 0.5, cacheWrite: 2 },
};

/** The catalog entry whose API id this is, ignoring a date suffix and a `[1m]` context tag. */
export function catalogModelForApiId(model: string): CatalogModel | undefined {
  const id = model
    .trim()
    .toLowerCase()
    .replace(/\[1m\]$/, '')
    .replace(/-\d{8}$/, '');
  const all: CatalogModel[] = [
    ...Object.values(CLAUDE_MODELS),
    ...Object.values(CODEX_MODELS),
    ...Object.values(GEMINI_CLI_MODELS),
  ];
  return all.find((m) => m.apiId === id);
}
