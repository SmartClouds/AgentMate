import { randomBytes } from 'node:crypto';
import { mkdir, readFile, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { TtsError } from './engines.js';
import { HostError, SupervisedHost } from './supervisedHost.js';
import type { VoiceProfiles } from './voiceProfiles.js';

/**
 * OmniVoice on this computer (E37): an optional engine whose weights are for non-commercial use
 * only. It speaks with a voice profile, cloning the voice from the profile's recording. The model
 * stays loaded in a sidecar (`assets/voice/omnivoice_server.py`, our own code calling OmniVoice's
 * public API) between pieces, and the sidecar stops after ten idle minutes.
 */

export interface OmniVoiceSetup {
  python: string;
  /** Put before the script; the tests run a stand-in this way. */
  prefixArgs?: readonly string[];
  script: string;
  modelDir: string;
  workDir: string;
  profiles: VoiceProfiles;
  onLog?: (line: string) => void;
  idleShutdownMs?: number;
  /** Added to the sidecar's environment. */
  env?: Record<string, string>;
}

/** Loading the model onto the card, or into memory on a computer without one. */
const READY_TIMEOUT_MS = 5 * 60_000;
const IDLE_SHUTDOWN_MS = 10 * 60_000;
/** Cloned speech is slow without a graphics card: a generous budget per character. */
const timeoutFor = (text: string) => 120_000 + text.length * 1500;

export function createOmniVoiceSpeaker(setup: OmniVoiceSetup) {
  const host = new SupervisedHost({
    command: setup.python,
    args: [...(setup.prefixArgs ?? []), '-X', 'utf8', setup.script, setup.modelDir],
    readyTimeoutMs: READY_TIMEOUT_MS,
    idleShutdownMs: setup.idleShutdownMs ?? IDLE_SHUTDOWN_MS,
    name: 'OmniVoice',
    onLog: setup.onLog,
    env: setup.env,
  });

  const speak = async ({
    voice,
    text,
    signal,
  }: {
    voice: string;
    text: string;
    lang: string;
    signal?: AbortSignal;
  }): Promise<Uint8Array> => {
    const profile = await setup.profiles.get(voice);
    if (!profile) throw new TtsError('That voice profile is not there any more.', false);
    // Every profile is made with consent; one without it (an old or hand-edited file) is refused.
    if (!profile.consent?.statement || !profile.consent.at) {
      throw new TtsError(
        'This voice profile has no consent recorded, so it cannot be cloned.',
        false,
      );
    }
    await mkdir(setup.workDir, { recursive: true });
    const out = join(setup.workDir, `${randomBytes(6).toString('hex')}.wav`);
    try {
      const answer = await host.request(
        {
          op: 'speak',
          text,
          ref_audio: setup.profiles.recording(profile.id),
          ref_text: profile.transcript || null,
          out,
        },
        { timeoutMs: timeoutFor(text), signal },
      );
      if (answer.ok !== true) {
        throw new TtsError(`OmniVoice could not speak this. ${answer.error ?? ''}`.trim(), false);
      }
      return new Uint8Array(await readFile(out));
    } catch (error) {
      if (error instanceof HostError) {
        // A crash or a hang fails this piece; trying again starts a fresh sidecar.
        throw new TtsError(error.message, error.crashed);
      }
      throw error;
    } finally {
      await rm(out, { force: true });
    }
  };

  return Object.assign(speak, { stop: () => host.stop(), host });
}
