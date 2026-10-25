import { STUDIO_TTS } from '@agentmat/core';
import type { VoiceEngineView, VoiceView } from '../../api.js';
import {
  TTS_ENGINES,
  type TtsEngineId,
  voicesFor,
  voicesWithoutChinese,
} from '../../voice/voices.js';
import { type EngineKeys, elevenLabsVoices } from './engines.js';

/**
 * Keys for the voice engines. OpenAI and Gemini use the keys the app already has in Settings > AI;
 * ElevenLabs and Azure keys are Studio's own, sealed by the host with the app's vault.
 */

/** Studio's sealed secrets, kept by the host. */
export interface StudioSecretsHost {
  /** The secret, or null when none is set. Throws when the vault holding it is locked. */
  get(name: string): Promise<string | null>;
  /** Seals and saves a secret; null forgets it. Throws when the vault is locked. */
  set(name: string, value: string | null): Promise<void>;
  /** Whether reading this secret needs the vault unlocked first. */
  isLocked(name: string): Promise<boolean>;
}

export interface StudioVoiceHost {
  /** The OpenAI and Gemini keys from the app's own AI settings. */
  appKeys(): Promise<{ openai?: string | null; gemini?: string | null }>;
  secrets: StudioSecretsHost;
  /** The app's fetch, which goes through its proxy settings. */
  fetch: typeof fetch;
  /** Sends every engine's requests here instead (the e2e fake servers). */
  baseUrl?: string;
}

export type StudioKeyEngine = 'elevenlabs' | 'azure';

const SECRET = { elevenlabs: 'tts.elevenlabs', azure: 'tts.azure' } as const;

const NO_KEY: Record<TtsEngineId, string> = {
  openai: 'Add an OpenAI API key in Settings > AI.',
  gemini: 'Add a Gemini API key in Settings > AI.',
  elevenlabs: 'Add an ElevenLabs key in Settings > Studio.',
  azure: 'Add an Azure Speech key and region in Settings > Studio.',
};

export interface VoiceKeys {
  /** Every key that can be read now; a locked or missing one is left out. */
  keys(): Promise<EngineKeys>;
  engines(): Promise<VoiceEngineView[]>;
  voices(input: { engine: TtsEngineId; lang: string }): Promise<VoiceView[]>;
  setKey(input: { engine: StudioKeyEngine; key: string | null; region?: string }): Promise<void>;
}

async function readSecret(host: StudioVoiceHost, engine: StudioKeyEngine) {
  if (await host.secrets.isLocked(SECRET[engine])) return { value: null, locked: true };
  return { value: await host.secrets.get(SECRET[engine]), locked: false };
}

function azureKey(value: string | null): EngineKeys['azure'] {
  if (!value) return null;
  try {
    const parsed = JSON.parse(value) as { key?: unknown; region?: unknown };
    return typeof parsed.key === 'string' && typeof parsed.region === 'string'
      ? { key: parsed.key, region: parsed.region }
      : null;
  } catch {
    return null;
  }
}

export function createVoiceKeys(host: StudioVoiceHost | undefined): VoiceKeys {
  async function keys(): Promise<EngineKeys> {
    if (!host) return {};
    const app = await host.appKeys();
    const [eleven, azure] = await Promise.all([
      readSecret(host, 'elevenlabs'),
      readSecret(host, 'azure'),
    ]);
    return {
      openai: app.openai?.trim() || null,
      gemini: app.gemini?.trim() || null,
      elevenlabs: eleven.value,
      azure: azureKey(azure.value),
    };
  }

  return {
    keys,

    async engines() {
      const found = await keys();
      const locked = host
        ? {
            elevenlabs: await host.secrets.isLocked(SECRET.elevenlabs),
            azure: await host.secrets.isLocked(SECRET.azure),
          }
        : { elevenlabs: false, azure: false };
      return TTS_ENGINES.map((id): VoiceEngineView => {
        const engine = STUDIO_TTS[id];
        const keyIn = id === 'openai' || id === 'gemini' ? 'app' : 'studio';
        const isLocked = keyIn === 'studio' && locked[id as StudioKeyEngine];
        let problem: string | null = null;
        if (!host) problem = 'Voices are not available in this copy of Studio.';
        else if (isLocked) problem = `Unlock the vault to use ${engine.label}.`;
        else if (!found[id]) problem = NO_KEY[id];
        return {
          id,
          label: engine.label,
          problem,
          locked: isLocked,
          keyIn,
          pricePerMillionChars: engine.pricePerMillionChars,
          retiresOn: engine.retiresOn ?? null,
        };
      });
    },

    async voices({ engine, lang }) {
      const listed = voicesFor(engine, lang);
      if (engine !== 'elevenlabs' || !host) return listed;
      // ElevenLabs voices belong to the account; eleven_v3 speaks every language with any of them.
      const key = (await keys()).elevenlabs;
      if (!key) return [];
      const account = await elevenLabsVoices({ key, fetch: host.fetch, baseUrl: host.baseUrl });
      return voicesWithoutChinese(account);
    },

    async setKey({ engine, key, region }) {
      if (!host) throw new Error('Voices are not available in this copy of Studio.');
      const value = key?.trim() || null;
      if (engine === 'azure' && value && !region) {
        throw new Error('Azure needs its region too, such as westeurope.');
      }
      await host.secrets.set(
        SECRET[engine],
        value && engine === 'azure' ? JSON.stringify({ key: value, region }) : value,
      );
    },
  };
}
