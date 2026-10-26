import type { AiProvider, AppSettings } from '@runova/core';

/** The AI provider Settings picked for writing prompts, with that provider's configured model. */
export function promptProviderModel(
  settings: Pick<
    AppSettings,
    'promptBuilderProvider' | 'openaiModel' | 'geminiModel' | 'ollamaModel'
  >,
): { provider: AiProvider; model: string } {
  const provider = settings.promptBuilderProvider;
  const model =
    provider === 'openai'
      ? settings.openaiModel
      : provider === 'gemini'
        ? settings.geminiModel
        : settings.ollamaModel;
  return { provider, model: model ?? '' };
}
