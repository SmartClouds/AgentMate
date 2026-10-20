import { describe, expect, it } from 'vitest';
import { CLI_REGISTRY } from '../cli/registry.js';
import { runProfileForTargetAI } from '../promptBuilder/runRecommendation.js';
import { getModelPrice } from '../usage/pricing.js';
import {
  CLAUDE_MODELS,
  CLI_MODEL_EXAMPLES,
  CODEX_MODELS,
  CURSOR_MODELS,
  catalogModelForApiId,
  DEFAULT_GEMINI_API_MODEL,
  DEFAULT_OPENAI_API_MODEL,
  DEFAULT_WHISPER_MODEL,
  DIFFRAY_EXECUTOR_MODELS,
  GEMINI_API_MODELS,
  GEMINI_CLI_MODELS,
  GROK_MODELS,
  HELP_EMBEDDING_MODEL_OPTIONS,
  HELP_EMBEDDING_MODELS,
  helpEmbeddingModel,
  normalizeHelpEmbeddingModels,
  OPENAI_API_MODELS,
  resolveSpeechLanguage,
  SPEECH_LANGUAGES,
  speechModelTooSmallFor,
  WHISPER_MODEL_LARGE_TURBO,
  WHISPER_MODELS,
} from './catalog.js';

describe('resolveSpeechLanguage', () => {
  it('keeps a language the user picked', () => {
    expect(resolveSpeechLanguage('fa', 'en-US')).toBe('fa');
    expect(resolveSpeechLanguage('en', 'fa-IR')).toBe('en');
  });

  // The local runtime treats "no language" as English, so "auto" must never reach it.
  it('turns the old auto-detect into the system language', () => {
    expect(resolveSpeechLanguage('auto', 'fa-IR')).toBe('fa');
    expect(resolveSpeechLanguage('auto', 'de_DE')).toBe('de');
    expect(resolveSpeechLanguage('auto', 'en-GB')).toBe('en');
  });

  it('falls back to English for a system language or value it does not know', () => {
    expect(resolveSpeechLanguage('auto', 'ja-JP')).toBe('en');
    expect(resolveSpeechLanguage('klingon', '')).toBe('en');
    expect(resolveSpeechLanguage(undefined)).toBe('en');
    expect(resolveSpeechLanguage('')).toBe('en');
  });
});

describe('speechModelTooSmallFor', () => {
  it('flags the small models for Persian and clears the large one', () => {
    expect(speechModelTooSmallFor('tiny', 'fa')).toBe(true);
    expect(speechModelTooSmallFor('base', 'fa')).toBe(true);
    expect(speechModelTooSmallFor('small', 'fa')).toBe(true);
    expect(speechModelTooSmallFor(WHISPER_MODEL_LARGE_TURBO, 'fa')).toBe(false);
  });

  it('never flags English', () => {
    for (const model of WHISPER_MODELS) {
      expect(speechModelTooSmallFor(model.key, 'en')).toBe(false);
    }
  });
});

// These guard the catalog against a half-done update: a renamed model that loses its price, a
// default that is no longer in its own list, or an example for a CLI that no longer exists.
describe('model catalog', () => {
  it('prices every Claude, Codex, and Gemini CLI model', () => {
    const models = [CLAUDE_MODELS, CODEX_MODELS, GEMINI_CLI_MODELS].flatMap((m) =>
      Object.values(m),
    );
    for (const model of models) {
      expect(getModelPrice(model.apiId), model.apiId).not.toBeNull();
    }
  });

  it('prices every Grok model and keeps each CLI argument unique', () => {
    for (const model of Object.values(GROK_MODELS)) {
      expect(getModelPrice(model.apiId), model.apiId).not.toBeNull();
    }
    for (const models of [GROK_MODELS, CURSOR_MODELS]) {
      const args = Object.values(models).map((m) => m.cliArg);
      expect(new Set(args).size).toBe(args.length);
    }
  });

  // Pricing matches by prefix, so a -lite id that loses its own entry is billed as its parent.
  it('prices a Gemini flash-lite model at its own rate, not the Flash rate it starts with', () => {
    expect(getModelPrice('gemini-2.5-flash')?.input).toBe(0.3);
    expect(getModelPrice('gemini-2.5-flash-lite')?.input).toBe(0.1);
    expect(getModelPrice('gemini-3.1-flash-lite')?.input).toBe(0.25);
  });

  it('offers Diffray the same Cursor models as the launch menu', () => {
    expect(DIFFRAY_EXECUTOR_MODELS['cursor-agent-cli']).toEqual(
      Object.values(CURSOR_MODELS).map((m) => ({ value: m.cliArg, label: m.label })),
    );
  });

  it('keeps each default inside its own list', () => {
    expect(OPENAI_API_MODELS.map((m) => m.value)).toContain(DEFAULT_OPENAI_API_MODEL);
    expect(GEMINI_API_MODELS.map((m) => m.value)).toContain(DEFAULT_GEMINI_API_MODEL);
    expect(WHISPER_MODELS.map((m) => m.key)).toContain(DEFAULT_WHISPER_MODEL);
  });

  it('keeps the large Whisper model quantized, so it is not a multi-GB download', () => {
    const large = WHISPER_MODELS.find((m) => m.key === WHISPER_MODEL_LARGE_TURBO);
    expect(large?.hubId).toBe('onnx-community/whisper-large-v3-turbo');
    expect(large?.dtype).toBeTruthy();
    // Every language that asks for a bigger model asks for one that exists.
    for (const lang of SPEECH_LANGUAGES) {
      if (lang.recommendedModel) {
        expect(WHISPER_MODELS.map((m) => m.key)).toContain(lang.recommendedModel);
      }
    }
  });

  it('names an embedding model with a positive vector size for every API provider', () => {
    expect(Object.keys(HELP_EMBEDDING_MODELS).sort()).toEqual(['gemini', 'ollama', 'openai']);
    for (const model of Object.values(HELP_EMBEDDING_MODELS)) {
      expect(model.id).not.toBe('');
      expect(model.dimensions).toBeGreaterThan(0);
    }
  });

  it('only has examples for CLIs in the registry', () => {
    const ids = new Set(CLI_REGISTRY.map((cli) => cli.id));
    for (const cliId of Object.keys(CLI_MODEL_EXAMPLES)) expect(ids.has(cliId), cliId).toBe(true);
  });

  it('is what the run profiles show', () => {
    const labels = runProfileForTargetAI('claude-code').models.map((m) => m.label);
    expect(labels).toEqual(Object.values(CLAUDE_MODELS).map((m) => m.label));
  });

  it('finds a model by API id, ignoring dates and the 1M tag', () => {
    expect(catalogModelForApiId(`${CLAUDE_MODELS.opus.apiId}-20260101`)).toBe(CLAUDE_MODELS.opus);
    expect(catalogModelForApiId(`${CLAUDE_MODELS.opus.apiId}[1m]`)).toBe(CLAUDE_MODELS.opus);
    expect(catalogModelForApiId('some-other-model')).toBeUndefined();
  });
});

describe('help embedding model options', () => {
  it('offers the default first for every provider', () => {
    for (const provider of Object.keys(HELP_EMBEDDING_MODELS) as Array<
      keyof typeof HELP_EMBEDDING_MODELS
    >) {
      const values = HELP_EMBEDDING_MODEL_OPTIONS[provider].map((o) => o.value);
      // The picker shows the first entry as the recommended one, so it has to be what is used when
      // nothing is picked.
      expect(values[0], provider).toBe(HELP_EMBEDDING_MODELS[provider].id);
      expect(new Set(values).size, provider).toBe(values.length);
    }
  });

  it('covers exactly the providers that have a default', () => {
    expect(Object.keys(HELP_EMBEDDING_MODEL_OPTIONS).sort()).toEqual(
      Object.keys(HELP_EMBEDDING_MODELS).sort(),
    );
  });
});

describe('helpEmbeddingModel', () => {
  it('returns the model picked for that provider, trimmed', () => {
    expect(helpEmbeddingModel('openai', { openai: '  text-embedding-3-large ' })).toBe(
      'text-embedding-3-large',
    );
  });

  it('only looks at its own provider', () => {
    expect(helpEmbeddingModel('gemini', { openai: 'text-embedding-3-large' })).toBe(
      HELP_EMBEDDING_MODELS.gemini.id,
    );
  });

  it('falls back to the default when nothing usable is picked', () => {
    expect(helpEmbeddingModel('ollama', {})).toBe(HELP_EMBEDDING_MODELS.ollama.id);
    expect(helpEmbeddingModel('ollama', { ollama: '' })).toBe(HELP_EMBEDDING_MODELS.ollama.id);
    expect(helpEmbeddingModel('ollama', { ollama: '   ' })).toBe(HELP_EMBEDDING_MODELS.ollama.id);
    expect(helpEmbeddingModel('ollama', null)).toBe(HELP_EMBEDDING_MODELS.ollama.id);
    expect(helpEmbeddingModel('ollama', undefined)).toBe(HELP_EMBEDDING_MODELS.ollama.id);
  });
});

describe('normalizeHelpEmbeddingModels', () => {
  it('keeps a good pick for each known provider', () => {
    expect(normalizeHelpEmbeddingModels({ openai: 'a', gemini: 'b', ollama: 'bge-m3' })).toEqual({
      openai: 'a',
      gemini: 'b',
      ollama: 'bge-m3',
    });
  });

  it('drops providers it does not know', () => {
    expect(normalizeHelpEmbeddingModels({ anthropic: 'x', ollama: 'bge-m3' })).toEqual({
      ollama: 'bge-m3',
    });
  });

  it('drops values that are not non-empty strings', () => {
    expect(normalizeHelpEmbeddingModels({ openai: 5, gemini: '   ', ollama: ['bge-m3'] })).toEqual(
      {},
    );
    expect(normalizeHelpEmbeddingModels({ openai: null, gemini: { id: 'x' } })).toEqual({});
  });

  it('trims names and caps them at 200 characters', () => {
    const out = normalizeHelpEmbeddingModels({ openai: '  spaced  ', ollama: 'm'.repeat(500) });
    expect(out.openai).toBe('spaced');
    expect(out.ollama).toHaveLength(200);
  });

  it('turns anything that is not a plain object into an empty map', () => {
    for (const junk of [null, undefined, 'openai', 7, true, ['openai']]) {
      expect(normalizeHelpEmbeddingModels(junk), String(junk)).toEqual({});
    }
  });
});
