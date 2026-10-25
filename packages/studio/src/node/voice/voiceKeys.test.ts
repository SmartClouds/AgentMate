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
      ['piper', 'none', 'Install Piper and its voices from Agent Tools, Dev Setup (Studio).'],
      [
        'omnivoice',
        'none',
        'Install OmniVoice and its model from Agent Tools, Dev Setup (Studio).',
      ],
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

describe('local engines', () => {
  const profile = (id: string, at: number) => ({ id, name: `Voice ${id}`, consent: { at } });

  it('offers the installed Piper voices for the language, flagged when non-commercial', async () => {
    const { host } = fakeHost();
    host.local = async () => ({
      piper: {
        python: 'py',
        voicesDir: 'v',
        voices: ['fa_IR-amir-medium', 'en_US-hfc_female-medium'],
      },
      omnivoice: null,
    });
    const voices = createVoiceKeys(host);
    const piper = (await voices.engines()).find((e) => e.id === 'piper');
    expect(piper).toMatchObject({
      problem: null,
      local: true,
      keyIn: 'none',
      nonCommercial: false,
    });
    expect(await voices.voices({ engine: 'piper', lang: 'fa' })).toEqual([
      {
        id: 'fa_IR-amir-medium',
        label: 'Amir',
        locale: 'fa-IR',
        gender: 'male',
        nonCommercial: false,
        license: 'CC0',
      },
    ]);
    expect((await voices.voices({ engine: 'piper', lang: 'en' }))[0]).toMatchObject({
      nonCommercial: true,
      license: 'CC BY-NC-SA 4.0',
    });
  });

  it('asks for the voices when only Piper is there, and a profile before OmniVoice can speak', async () => {
    const { host } = fakeHost();
    host.local = async () => ({
      piper: { python: 'py', voicesDir: 'v', voices: [] },
      omnivoice: { python: 'py', modelDir: 'm' },
    });
    const none = createVoiceKeys(host, async () => [profile('p0', 0)]);
    const engines = await none.engines();
    expect(engines.find((e) => e.id === 'piper')?.problem).toBe(
      'Install the Piper voices from Agent Tools, Dev Setup (Studio).',
    );
    expect(engines.find((e) => e.id === 'omnivoice')).toMatchObject({
      problem: 'Make a voice profile first: Voices, then New voice.',
      nonCommercial: true,
      clones: true,
    });
    const some = createVoiceKeys(host, async () => [profile('p0', 0), profile('p1', 5)]);
    expect((await some.engines()).find((e) => e.id === 'omnivoice')?.problem).toBeNull();
    // Only profiles made with consent are offered.
    expect(await some.voices({ engine: 'omnivoice', lang: 'fa' })).toEqual([
      { id: 'p1', label: 'Voice p1', nonCommercial: true, license: 'CC BY-NC 4.0' },
    ]);
  });
});
