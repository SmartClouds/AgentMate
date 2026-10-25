import { STUDIO_TTS, type StudioTtsVoice } from '@agentmat/core';
import { withoutChinese } from '../text/languages.js';

/**
 * Voices as a scene names them: `<engine>:<voice id>` in the scene's `voiceRef`, so a video keeps
 * the voice each scene was spoken with. Recorded narration is `recording`.
 */

export const TTS_ENGINES = ['openai', 'gemini', 'elevenlabs', 'azure'] as const;
export type TtsEngineId = (typeof TTS_ENGINES)[number];

export const RECORDED_VOICE = 'recording';

export interface VoiceRef {
  engine: TtsEngineId;
  voice: string;
}

export function formatVoiceRef(ref: VoiceRef): string {
  return `${ref.engine}:${ref.voice}`;
}

export function parseVoiceRef(value: string | null | undefined): VoiceRef | null {
  if (!value) return null;
  const at = value.indexOf(':');
  if (at < 0) return null;
  const engine = value.slice(0, at);
  const voice = value.slice(at + 1);
  if (!(TTS_ENGINES as readonly string[]).includes(engine) || !voice) return null;
  return { engine: engine as TtsEngineId, voice };
}

/** Voices without any Chinese one, by locale or by name: Studio never offers Chinese. */
export function voicesWithoutChinese<T extends { locale?: string; label: string }>(
  voices: readonly T[],
): T[] {
  return withoutChinese(voices, (v) => v.locale ?? '').filter(
    (v) => !/\p{Script=Han}/u.test(v.label),
  );
}

/**
 * The voices an engine offers for a language: every voice of an engine whose voices speak any
 * language, and only that language's voices of an engine with one voice per locale.
 */
export function voicesFor(
  engine: TtsEngineId,
  lang: string,
  extra: readonly StudioTtsVoice[] = [],
): StudioTtsVoice[] {
  const all = voicesWithoutChinese([...STUDIO_TTS[engine].voices, ...extra]);
  const primary = lang.split('-')[0]?.toLowerCase() ?? '';
  const local = all.filter((v) => {
    const locale = v.locale?.toLowerCase();
    return locale === primary || locale?.startsWith(`${primary}-`);
  });
  return all.some((v) => v.locale) ? local : all;
}
