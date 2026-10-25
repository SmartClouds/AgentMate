import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { type FakeTtsServer, GOOD_KEY, startFakeTts } from '../../test/fakeTts.js';
import { createVoiceKeys, type StudioVoiceHost } from './voiceKeys.js';

let server: FakeTtsServer;
beforeAll(async () => {
  server = await startFakeTts();
});
afterAll(async () => {
  await server.close();
});

/** A host whose sealed secrets live in a map, behind a vault that can be locked. */
function fakeHost(app: { openai?: string | null; gemini?: string | null } = {}) {
  const saved = new Map<string, string>();
  const vault = { locked: false };
  const host: StudioVoiceHost = {
    appKeys: async () => app,
    secrets: {
      async get(name) {
        if (vault.locked && saved.has(name)) throw new Error('The vault is locked.');
        return saved.get(name) ?? null;
      },
      async set(name, value) {
        if (vault.locked) throw new Error('The vault is locked.');
        if (value === null) saved.delete(name);
        else saved.set(name, value);
      },
      isLocked: async (name) => vault.locked && saved.has(name),
    },
    fetch,
    baseUrl: server.url,
  };
  return { host, saved, vault };
}

describe('voice engine keys', () => {
  it('says what each engine is missing, and takes the app keys for OpenAI and Gemini', async () => {
    const { host } = fakeHost({ openai: ' sk-1 ', gemini: '' });
    const voices = createVoiceKeys(host);
    const engines = await voices.engines();
    expect(engines.map((e) => [e.id, e.keyIn, e.problem])).toEqual([
      ['openai', 'app', null],
      ['gemini', 'app', 'Add a Gemini API key in Settings > AI.'],
      ['elevenlabs', 'studio', 'Add an ElevenLabs key in Settings > Studio.'],
      ['azure', 'studio', 'Add an Azure Speech key and region in Settings > Studio.'],
    ]);
    expect(engines[0]).toMatchObject({ pricePerMillionChars: 15, retiresOn: '2027-01-06' });
    expect((await voices.keys()).openai).toBe('sk-1');
  });

  it('seals Studio keys through the host, needs the Azure region, and forgets a key', async () => {
    const { host, saved } = fakeHost();
    const voices = createVoiceKeys(host);
    await expect(voices.setKey({ engine: 'azure', key: 'k' })).rejects.toThrow(
      'Azure needs its region too, such as westeurope.',
    );
    await voices.setKey({ engine: 'azure', key: ' k ', region: 'westeurope' });
    await voices.setKey({ engine: 'elevenlabs', key: 'e' });
    expect(await voices.keys()).toMatchObject({
      azure: { key: 'k', region: 'westeurope' },
      elevenlabs: 'e',
    });
    await voices.setKey({ engine: 'elevenlabs', key: '  ' });
    expect(saved.has('tts.elevenlabs')).toBe(false);
    saved.set('tts.azure', 'not json');
    expect((await voices.keys()).azure).toBeNull();
  });

  it('asks for the vault to be unlocked instead of skipping a locked engine', async () => {
    const { host, vault } = fakeHost();
    const voices = createVoiceKeys(host);
    await voices.setKey({ engine: 'elevenlabs', key: GOOD_KEY });
    vault.locked = true;
    const eleven = (await voices.engines()).find((e) => e.id === 'elevenlabs');
    expect(eleven).toMatchObject({ locked: true, problem: 'Unlock the vault to use ElevenLabs.' });
    expect((await voices.keys()).elevenlabs).toBeNull();
  });

  it('lists the account voices of ElevenLabs without Chinese ones, and catalog voices by language', async () => {
    const { host } = fakeHost();
    const voices = createVoiceKeys(host);
    expect(await voices.voices({ engine: 'elevenlabs', lang: 'fa' })).toEqual([]);
    await voices.setKey({ engine: 'elevenlabs', key: GOOD_KEY });
    expect(await voices.voices({ engine: 'elevenlabs', lang: 'fa' })).toEqual([
      { id: 'v-rachel', label: 'Rachel', gender: 'female' },
    ]);
    const azure = await voices.voices({ engine: 'azure', lang: 'fa' });
    expect(azure.map((v) => v.id)).toEqual(['fa-IR-DilaraNeural', 'fa-IR-FaridNeural']);
  });

  it('works without a host only to say voices are unavailable', async () => {
    const voices = createVoiceKeys(undefined);
    expect(await voices.keys()).toEqual({});
    expect((await voices.engines()).every((e) => e.problem?.startsWith('Voices are not'))).toBe(
      true,
    );
    expect(await voices.voices({ engine: 'openai', lang: 'en' })).toHaveLength(13);
    await expect(voices.setKey({ engine: 'elevenlabs', key: 'x' })).rejects.toThrow(
      'Voices are not available',
    );
  });
});
