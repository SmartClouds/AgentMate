import { STUDIO_TTS, type StudioTtsVoice } from '@agentmat/core';
import { type WordTiming, wordsFromCharacters } from '../../voice/text.js';
import type { TtsEngineId } from '../../voice/voices.js';
import { encodeWav, parseWav } from '../../voice/wav.js';

/**
 * The voice engines, one request each, as their docs stood in October 2026: OpenAI's speech
 * endpoint, Gemini's interactions with an audio response, ElevenLabs with character timings, and
 * Azure's SSML endpoint. Every one answers with a WAV file (raw PCM is wrapped), so lengths are
 * read from samples. A refused key is said plainly; rate limits and server trouble are marked so
 * the caller can try again.
 */

export interface EngineKeys {
  openai?: string | null;
  gemini?: string | null;
  elevenlabs?: string | null;
  azure?: { key: string; region: string } | null;
}

export class TtsError extends Error {
  constructor(
    message: string,
    /** Worth trying again later: a rate limit, a server error, a dropped connection. */
    readonly retryable: boolean,
  ) {
    super(message);
    this.name = 'TtsError';
  }
}

export interface SpeakInput {
  engine: TtsEngineId;
  voice: string;
  text: string;
  lang: string;
  keys: EngineKeys;
  fetch: typeof fetch;
  signal?: AbortSignal;
  /** Sends every engine's requests here instead (tests and the e2e fake servers). */
  baseUrl?: string;
}

export interface SpokenAudio {
  /** A WAV file. */
  wav: Uint8Array;
  /** Word timings from the engine, when it gives them. */
  words: WordTiming[] | null;
}

const LABEL: Record<TtsEngineId, string> = {
  openai: STUDIO_TTS.openai.label,
  gemini: STUDIO_TTS.gemini.label,
  elevenlabs: STUDIO_TTS.elevenlabs.label,
  azure: STUDIO_TTS.azure.label,
};

function needKey(engine: TtsEngineId): never {
  throw new TtsError(`${LABEL[engine]} has no key yet. Add it in Settings.`, false);
}

async function request(
  engine: TtsEngineId,
  input: SpeakInput,
  url: string,
  init: RequestInit,
): Promise<Response> {
  let response: Response;
  try {
    response = await input.fetch(url, { ...init, signal: input.signal });
  } catch (error) {
    if (input.signal?.aborted) throw error;
    throw new TtsError(
      `${LABEL[engine]} could not be reached: ${error instanceof Error ? error.message : String(error)}`,
      true,
    );
  }
  if (response.ok) return response;
  const body = (await response.text().catch(() => '')).slice(0, 300);
  const detail = body ? ` ${readableError(body)}` : '';
  if (response.status === 401 || response.status === 403) {
    throw new TtsError(`${LABEL[engine]} refused the key. Check it in Settings.${detail}`, false);
  }
  const retryable = response.status === 429 || response.status >= 500;
  throw new TtsError(`${LABEL[engine]} answered ${response.status}.${detail}`, retryable);
}

/** The message out of a JSON error body, or the body itself. */
function readableError(body: string): string {
  try {
    const parsed = JSON.parse(body) as {
      error?: { message?: string } | string;
      detail?: { message?: string } | string;
      message?: string;
    };
    const error = parsed.error;
    if (typeof error === 'string') return error;
    if (error?.message) return error.message;
    const detail = parsed.detail;
    if (typeof detail === 'string') return detail;
    if (detail?.message) return detail.message;
    if (parsed.message) return parsed.message;
  } catch {
    // Not JSON.
  }
  return body;
}

function asWav(bytes: Uint8Array, rawRate: number): Uint8Array {
  const riff = bytes.length >= 12 && String.fromCharCode(...bytes.subarray(0, 4)) === 'RIFF';
  return riff ? bytes : encodeWav(bytes, rawRate);
}

function escapeXml(text: string): string {
  return text.replace(
    /[<>&'"]/g,
    (c) => ({ '<': '&lt;', '>': '&gt;', '&': '&amp;', "'": '&apos;', '"': '&quot;' })[c] as string,
  );
}

export async function speak(input: SpeakInput): Promise<SpokenAudio> {
  const { engine, keys, text } = input;
  if (engine === 'openai') {
    const key = keys.openai ?? needKey(engine);
    const response = await request(
      engine,
      input,
      `${input.baseUrl ?? 'https://api.openai.com'}/v1/audio/speech`,
      {
        method: 'POST',
        headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: STUDIO_TTS.openai.model,
          input: text,
          voice: input.voice,
          response_format: 'wav',
        }),
      },
    );
    return { wav: asWav(new Uint8Array(await response.arrayBuffer()), 24_000), words: null };
  }
  if (engine === 'gemini') {
    const key = keys.gemini ?? needKey(engine);
    const response = await request(
      engine,
      input,
      `${input.baseUrl ?? 'https://generativelanguage.googleapis.com'}/v1beta/interactions`,
      {
        method: 'POST',
        headers: { 'x-goog-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: STUDIO_TTS.gemini.model,
          input: [{ type: 'user_input', content: [{ type: 'text', text }] }],
          response_format: { type: 'audio' },
          generation_config: { speech_config: [{ voice: input.voice }] },
        }),
      },
    );
    const answer = (await response.json()) as {
      steps?: { type?: string; content?: { type?: string; data?: string }[] }[];
    };
    const audio = (answer.steps ?? [])
      .filter((s) => s.type === 'model_output')
      .flatMap((s) => s.content ?? [])
      .filter((c) => c.type === 'audio' && c.data)
      .at(-1);
    if (!audio?.data) throw new TtsError('Google Gemini answered without any sound.', true);
    return { wav: asWav(Buffer.from(audio.data, 'base64'), 24_000), words: null };
  }
  if (engine === 'elevenlabs') {
    const key = keys.elevenlabs ?? needKey(engine);
    const base = input.baseUrl ?? 'https://api.elevenlabs.io';
    const response = await request(
      engine,
      input,
      `${base}/v1/text-to-speech/${encodeURIComponent(input.voice)}/with-timestamps?output_format=pcm_48000`,
      {
        method: 'POST',
        headers: { 'xi-api-key': key, 'Content-Type': 'application/json' },
        body: JSON.stringify({ text, model_id: STUDIO_TTS.elevenlabs.model }),
      },
    );
    const answer = (await response.json()) as {
      audio_base64?: string;
      alignment?: {
        characters?: string[];
        character_start_times_seconds?: number[];
        character_end_times_seconds?: number[];
      } | null;
    };
    if (!answer.audio_base64) throw new TtsError('ElevenLabs answered without any sound.', true);
    const a = answer.alignment;
    const words =
      a?.characters && a.character_start_times_seconds && a.character_end_times_seconds
        ? wordsFromCharacters(
            a.characters,
            a.character_start_times_seconds,
            a.character_end_times_seconds,
          )
        : null;
    return { wav: encodeWav(Buffer.from(answer.audio_base64, 'base64'), 48_000), words };
  }
  const azure = keys.azure ?? needKey(engine);
  const locale =
    STUDIO_TTS.azure.voices.find((v) => v.id === input.voice)?.locale ??
    input.voice.split('-').slice(0, 2).join('-');
  const ssml = `<speak version='1.0' xml:lang='${locale}'><voice xml:lang='${locale}' name='${escapeXml(input.voice)}'>${escapeXml(text)}</voice></speak>`;
  const response = await request(
    engine,
    input,
    `${input.baseUrl ?? `https://${azure.region}.tts.speech.microsoft.com`}/cognitiveservices/v1`,
    {
      method: 'POST',
      headers: {
        'Ocp-Apim-Subscription-Key': azure.key,
        'Content-Type': 'application/ssml+xml',
        'X-Microsoft-OutputFormat': 'riff-48khz-16bit-mono-pcm',
        'User-Agent': 'AgentMate-Studio',
      },
      body: ssml,
    },
  );
  const wav = new Uint8Array(await response.arrayBuffer());
  parseWav(wav);
  return { wav, words: null };
}

/** The voices in the user's ElevenLabs account, with the language its labels name. */
export async function elevenLabsVoices(input: {
  key: string;
  fetch: typeof fetch;
  baseUrl?: string;
  signal?: AbortSignal;
}): Promise<StudioTtsVoice[]> {
  const response = await request(
    'elevenlabs',
    { ...input, engine: 'elevenlabs', voice: '', text: '', lang: '', keys: {} },
    `${input.baseUrl ?? 'https://api.elevenlabs.io'}/v1/voices`,
    {
      headers: { 'xi-api-key': input.key },
    },
  );
  const answer = (await response.json()) as {
    voices?: {
      voice_id?: string;
      name?: string;
      labels?: { language?: string; gender?: string };
    }[];
  };
  return (answer.voices ?? [])
    .filter((v) => v.voice_id && v.name)
    .map((v) => ({
      id: v.voice_id as string,
      label: v.name as string,
      ...(v.labels?.language ? { locale: v.labels.language } : {}),
      ...(v.labels?.gender === 'female' || v.labels?.gender === 'male'
        ? { gender: v.labels.gender }
        : {}),
    }));
}
