import { copyFile, mkdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { z } from 'zod';
import { CONSENT_STATEMENT } from '../../api.js';
import { JsonStore } from '../settings/jsonStore.js';

/**
 * Voice profiles (E37): a recording of someone's voice that a cloning engine can speak with,
 * kept in Studio's data folder and reused across videos. Every profile carries the consent its
 * maker gave ("this is my own voice, or I have permission to use it"), and no engine clones from
 * a profile without one. A profile's recording never changes; a new take is a new profile, so a
 * narration spoken with a profile always meant the same voice.
 */

const profileSchema = z.object({
  id: z.string(),
  name: z.string(),
  lang: z.string(),
  createdAt: z.number(),
  seconds: z.number(),
  /** What the recording says, which helps a cloning engine; filled in by speech recognition. */
  transcript: z.string(),
  consent: z.object({ statement: z.string(), at: z.number() }),
  /** The same voice in an online account, once the person chose to upload it there. */
  bindings: z.object({ elevenlabs: z.string().optional() }),
});
export type VoiceProfile = z.infer<typeof profileSchema>;

const fileSchema = z.object({
  version: z.literal(1),
  profiles: z.array(profileSchema),
});

export class VoiceProfiles {
  private readonly store: JsonStore<z.infer<typeof fileSchema>>;

  constructor(
    private readonly dir: string,
    private readonly now: () => number,
    private readonly newId: () => string,
  ) {
    this.store = new JsonStore(
      join(dir, 'profiles.json'),
      fileSchema,
      () => ({ version: 1 as const, profiles: [] }),
      now,
    );
  }

  async list(): Promise<VoiceProfile[]> {
    return (await this.store.read()).profiles;
  }

  async get(id: string): Promise<VoiceProfile | null> {
    return (await this.list()).find((p) => p.id === id) ?? null;
  }

  /** The profile's recording: a mono WAV, trimmed and brought to a steady level. */
  recording(id: string): string {
    return join(this.dir, `${id}.wav`);
  }

  /** Keeps a copy of `wav` as a new profile's recording. Refuses without consent. */
  async create(input: {
    name: string;
    lang: string;
    wav: string;
    seconds: number;
    transcript: string;
    consent: boolean;
  }): Promise<VoiceProfile> {
    if (input.consent !== true) {
      throw new Error('A voice profile needs your confirmation that you may use this voice.');
    }
    const id = this.newId();
    await mkdir(this.dir, { recursive: true });
    await copyFile(input.wav, this.recording(id));
    const profile: VoiceProfile = {
      id,
      name: input.name.trim() || 'My voice',
      lang: input.lang,
      createdAt: this.now(),
      seconds: input.seconds,
      transcript: input.transcript.trim(),
      consent: { statement: CONSENT_STATEMENT, at: this.now() },
      bindings: {},
    };
    await this.store.mutate((file) => {
      file.profiles.push(profile);
    });
    return profile;
  }

  async update(
    id: string,
    patch: { name?: string; transcript?: string; elevenlabs?: string | null },
  ): Promise<VoiceProfile> {
    let found: VoiceProfile | null = null;
    await this.store.mutate((file) => {
      const profile = file.profiles.find((p) => p.id === id);
      if (!profile) return;
      if (patch.name !== undefined) profile.name = patch.name.trim() || profile.name;
      if (patch.transcript !== undefined) profile.transcript = patch.transcript.trim();
      if (patch.elevenlabs === null) delete profile.bindings.elevenlabs;
      else if (patch.elevenlabs) profile.bindings.elevenlabs = patch.elevenlabs;
      found = profile;
    });
    if (!found) throw new Error('That voice profile is not there any more.');
    return found;
  }

  async remove(id: string): Promise<void> {
    await this.store.mutate((file) => {
      file.profiles = file.profiles.filter((p) => p.id !== id);
    });
    await rm(this.recording(id), { force: true });
  }
}
