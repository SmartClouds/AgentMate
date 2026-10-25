import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ZH } from '../../test/chineseTags.js';
import { type FakeTtsServer, GOOD_KEY, startFakeTts } from '../../test/fakeTts.js';
import type { TtsEngineId } from '../../voice/voices.js';
import { parseWav } from '../../voice/wav.js';
import { type EngineKeys, elevenLabsVoices, speak, TtsError } from './engines.js';

let server: FakeTtsServer;
beforeAll(async () => {
  server = await startFakeTts();
});
afterAll(async () => {
  await server.close();
});

const KEYS: EngineKeys = {
  openai: GOOD_KEY,
  gemini: GOOD_KEY,
  elevenlabs: GOOD_KEY,
  azure: { key: GOOD_KEY, region: 'westeurope' },
};
const TEXT = 'سلام، این یک آزمایش است.';

function say(engine: TtsEngineId, voice: string, keys: EngineKeys = KEYS) {
  return speak({ engine, voice, text: TEXT, lang: 'fa', keys, fetch, baseUrl: server.url });
}

describe('voice engines', () => {
  it('speaks with OpenAI: the model, the voice and a WAV back', async () => {
    const spoken = await say('openai', 'coral');
    expect(parseWav(spoken.wav)).toMatchObject({ sampleRate: 24_000, channels: 1 });
    expect(spoken.words).toBeNull();
    const sent = JSON.parse(server.requests.at(-1)?.body ?? '{}');
    expect(sent).toEqual({
      model: 'gpt-4o-mini-tts',
      input: TEXT,
      voice: 'coral',
      response_format: 'wav',
    });
  });

  it('speaks with Gemini through interactions, taking the last audio of the model output', async () => {
    const spoken = await say('gemini', 'Kore');
    expect(parseWav(spoken.wav).sampleRate).toBe(24_000);
    const sent = JSON.parse(server.requests.at(-1)?.body ?? '{}');
    expect(sent).toMatchObject({
      model: 'gemini-3.8-flash-tts',
      input: [{ type: 'user_input', content: [{ type: 'text', text: TEXT }] }],
      response_format: { type: 'audio' },
      generation_config: { speech_config: [{ voice: 'Kore' }] },
    });
  });

  it('speaks with ElevenLabs at 48 kHz, with word timings from its character timings', async () => {
    const spoken = await say('elevenlabs', 'v-rachel');
    expect(parseWav(spoken.wav).sampleRate).toBe(48_000);
    expect(spoken.words?.map((w) => w.word)).toEqual(['سلام،', 'این', 'یک', 'آزمایش', 'است.']);
    expect(server.requests.at(-1)?.path).toBe('/v1/text-to-speech/v-rachel/with-timestamps');
    expect(JSON.parse(server.requests.at(-1)?.body ?? '{}').model_id).toBe('eleven_v3');
  });

  it('speaks with Azure through SSML in the voice locale, with its text escaped', async () => {
    const spoken = await speak({
      engine: 'azure',
      voice: 'fa-IR-DilaraNeural',
      text: 'a < b & "c"',
      lang: 'fa',
      keys: KEYS,
      fetch,
      baseUrl: server.url,
    });
    expect(parseWav(spoken.wav).sampleRate).toBe(48_000);
    const request = server.requests.at(-1);
    expect(request?.body).toBe(
      "<speak version='1.0' xml:lang='fa-IR'><voice xml:lang='fa-IR' name='fa-IR-DilaraNeural'>a &lt; b &amp; &quot;c&quot;</voice></speak>",
    );
    expect(request?.headers['x-microsoft-outputformat']).toBe('riff-48khz-16bit-mono-pcm');
    expect(request?.headers['user-agent']).toBe('AgentMate-Studio');
  });

  it('says a missing or refused key plainly, and that is not worth retrying', async () => {
    await expect(say('openai', 'coral', {})).rejects.toThrow(
      'OpenAI has no key yet. Add it in Settings.',
    );
    const refused = await say('gemini', 'Kore', { gemini: 'wrong' }).catch((e: unknown) => e);
    expect(refused).toBeInstanceOf(TtsError);
    expect((refused as TtsError).message).toBe(
      'Google Gemini refused the key. Check it in Settings. Incorrect API key provided.',
    );
    expect((refused as TtsError).retryable).toBe(false);
  });

  it('marks rate limits, server errors and lost connections as worth retrying', async () => {
    server.failNext(1, 429);
    const limited = (await say('azure', 'fa-IR-FaridNeural').catch((e: unknown) => e)) as TtsError;
    expect(limited.retryable).toBe(true);
    expect(limited.message).toBe('Azure Speech answered 429. Fake failure 429');
    server.failNext(1, 400);
    expect(((await say('openai', 'coral').catch((e: unknown) => e)) as TtsError).retryable).toBe(
      false,
    );
    const gone = (await speak({
      engine: 'openai',
      voice: 'x',
      text: 'x',
      lang: 'en',
      keys: KEYS,
      fetch,
      baseUrl: 'http://127.0.0.1:1',
    }).catch((e: unknown) => e)) as TtsError;
    expect(gone.retryable).toBe(true);
    expect(gone.message).toMatch(/^OpenAI could not be reached/);
  });

  it('lists the voices of the ElevenLabs account, labels and all', async () => {
    expect(await elevenLabsVoices({ key: GOOD_KEY, fetch, baseUrl: server.url })).toEqual([
      { id: 'v-rachel', label: 'Rachel', gender: 'female' },
      { id: 'v-yun', label: 'Yun', locale: ZH },
    ]);
  });
});
