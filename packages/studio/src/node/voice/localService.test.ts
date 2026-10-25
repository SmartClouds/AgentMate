import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { createScene } from '../../document/schema.js';
import { fakeFrameHost } from '../../test/fakeFrames.js';
import { type FakeTtsServer, GOOD_KEY, startFakeTts, tonePcm } from '../../test/fakeTts.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { encodeWav } from '../../voice/wav.js';
import { createStudioService, type StudioService } from '../service.js';

/**
 * Studio's local voices and voice profiles through the service (E37): Piper and OmniVoice spoken
 * with stand-ins for their processes, profiles made from a take with consent, and a profile
 * uploaded to ElevenLabs only when the person agreed to it.
 */

const PIPER = join(__dirname, '..', '..', 'test', 'fakePiper.mjs');
const SIDECAR = join(__dirname, '..', '..', 'test', 'fakeSidecar.mjs');
const tempDir = useTempDirs();
let tts: FakeTtsServer;
beforeAll(async () => {
  tts = await startFakeTts();
});
afterAll(async () => {
  await tts.close();
});
const services: StudioService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

async function setup(installed: { piper?: boolean; omnivoice?: boolean } = {}) {
  const root = await tempDir();
  const voicesDir = join(root, 'tools', 'models', 'piper-voices');
  await mkdir(voicesDir, { recursive: true });
  await writeFile(join(voicesDir, 'fa_IR-amir-medium.onnx'), 'model');
  const secrets = new Map<string, string>([['tts.elevenlabs', GOOD_KEY]]);
  const heard: string[] = [];
  const service = createStudioService({
    dataDir: join(root, 'userData', 'studio'),
    defaultLibraryRoot: join(root, 'Videos', 'AgentMate Studio'),
    defaultCacheDir: join(root, 'userData', 'studio-cache'),
    appDir: join(root, 'app'),
    appId: 'AgentMate',
    openDb: openNodeSqlite,
    projects: { get: () => null },
    notify: () => undefined,
    render: { tools: async () => fakeTools, frames: fakeFrameHost() },
    voice: {
      appKeys: async () => ({}),
      secrets: {
        get: async (name) => secrets.get(name) ?? null,
        set: async (name, value) => {
          if (value === null) secrets.delete(name);
          else secrets.set(name, value);
        },
        isLocked: async () => false,
      },
      fetch,
      baseUrl: tts.url,
      local: async () => ({
        piper: installed.piper
          ? {
              python: process.execPath,
              prefixArgs: [PIPER],
              voicesDir,
              voices: ['fa_IR-amir-medium'],
            }
          : null,
        omnivoice: installed.omnivoice
          ? { python: process.execPath, prefixArgs: [SIDECAR], modelDir: join(root, 'model') }
          : null,
      }),
      transcribe: async ({ wav, lang }) => {
        heard.push(`${lang}:${(await readFile(wav)).subarray(0, 4).toString('latin1')}`);
        return ' سلام، این صدای من است. ';
      },
    },
  });
  services.push(service);
  return { root, service, secrets, heard };
}

async function narratedVideo(service: StudioService) {
  const video = await service.create({
    title: 'Local',
    projectId: null,
    language: 'fa',
    aspect: '16:9',
  });
  const opened = await service.open({ videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  await service.apply({
    videoId: video.id,
    baseSeq: opened.session.status.seq,
    ops: [{ op: 'scene.add', index: 0, scene: createScene({ id: 'a', narration: 'سلام دنیا.' }) }],
    label: 'Scene',
  });
  return video.id;
}

async function finished(service: StudioService, videoId: string) {
  for (let i = 0; i < 400; i++) {
    const [job] = await service.narrationJobs({ videoId });
    if (job && job.status !== 'running') return job;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('narration did not finish');
}

const take = (seconds: number) => encodeWav(tonePcm(seconds, 48_000), 48_000);

describe('local voices through the service', () => {
  it('narrates with Piper once it is installed, and says what to install before', async () => {
    const before = await setup();
    const engines = await before.service.voiceEngines();
    expect(engines.find((e) => e.id === 'piper')?.problem).toMatch(/^Install Piper/);

    const { service } = await setup({ piper: true });
    expect(await service.voices({ engine: 'piper', lang: 'fa' })).toEqual([
      expect.objectContaining({ id: 'fa_IR-amir-medium', nonCommercial: false }),
    ]);
    const videoId = await narratedVideo(service);
    await service.speak({ videoId, sceneIds: ['a'], voiceRef: 'piper:fa_IR-amir-medium' });
    expect(await finished(service, videoId)).toMatchObject({ status: 'done', error: null });
    const doc = await service.open({ videoId });
    if (doc.state !== 'open') throw new Error('not open');
    expect(doc.session.document.scenario.scenes[0]?.voiceRef).toBe('piper:fa_IR-amir-medium');
  });

  it('makes a profile from a take with consent and a transcript, and clones it with OmniVoice', async () => {
    const { service, heard } = await setup({ omnivoice: true });
    const heardTake = await service.transcribeTake({
      bytes: take(5),
      mimeType: 'audio/wav',
      lang: 'fa',
    });
    expect(heardTake).toEqual({ text: 'سلام، این صدای من است.', seconds: 5 });
    expect(heard).toEqual(['fa:RIFF']);
    await expect(
      service.transcribeTake({ bytes: take(1), mimeType: 'audio/wav', lang: 'fa' }),
    ).rejects.toThrow(/^Record 3 to 60 seconds of speech; this take has 1\.0 s/);

    const profile = await service.createVoiceProfile({
      bytes: take(5),
      mimeType: 'audio/wav',
      name: 'Amin',
      lang: 'fa',
      transcript: heardTake.text,
      consent: true,
    });
    expect(profile).toMatchObject({ name: 'Amin', seconds: 5, elevenlabsVoiceId: null });
    expect(profile.consentAt).toBeGreaterThan(0);
    expect(await service.voices({ engine: 'omnivoice', lang: 'fa' })).toEqual([
      expect.objectContaining({ id: profile.id, label: 'Amin', nonCommercial: true }),
    ]);

    const videoId = await narratedVideo(service);
    await service.speak({ videoId, sceneIds: ['a'], voiceRef: `omnivoice:${profile.id}` });
    expect(await finished(service, videoId)).toMatchObject({ status: 'done' });
    expect((await service.updateVoiceProfile({ profileId: profile.id, name: 'Me' })).name).toBe(
      'Me',
    );
  });

  it('uploads a profile to ElevenLabs only with the person agreeing, and removes the clone with it', async () => {
    const { service, secrets } = await setup();
    const profile = await service.createVoiceProfile({
      bytes: take(4),
      mimeType: 'audio/wav',
      name: 'Amin',
      lang: 'fa',
      transcript: '',
      consent: true,
    });
    const cloned = await service.cloneVoiceProfile({
      profileId: profile.id,
      acknowledgeUpload: true,
    });
    expect(cloned.elevenlabsVoiceId).toBe('cloned-Amin');
    const upload = tts.requests.find((r) => r.path === '/v1/voices/add');
    expect(upload?.body).toContain('RIFF');
    // Cloning again does not upload again.
    const uploads = tts.requests.length;
    await service.cloneVoiceProfile({ profileId: profile.id, acknowledgeUpload: true });
    expect(tts.requests.length).toBe(uploads);

    await service.removeVoiceProfile({ profileId: profile.id });
    expect(tts.requests.at(-1)).toMatchObject({ path: '/v1/voices/cloned-Amin' });
    expect(await service.voiceProfiles()).toEqual([]);

    // Without a key, a bound profile cannot be removed (its clone would be left behind).
    const again = await service.createVoiceProfile({
      bytes: take(4),
      mimeType: 'audio/wav',
      name: 'B',
      lang: 'fa',
      transcript: '',
      consent: true,
    });
    await service.cloneVoiceProfile({ profileId: again.id, acknowledgeUpload: true });
    secrets.clear();
    await expect(service.removeVoiceProfile({ profileId: again.id })).rejects.toThrow(
      'Add an ElevenLabs key in Settings > Studio first.',
    );
    expect(await service.voiceProfiles()).toHaveLength(1);
    await expect(service.removeVoiceProfile({ profileId: 'gone' })).rejects.toThrow(
      'That voice profile is not there any more.',
    );
  });
});
