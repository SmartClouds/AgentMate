import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { join } from 'node:path';
import {
  createScene,
  type NarrationJobView,
  type OpenVideoResult,
  type VideoSummary,
  type VoiceEngineView,
} from '@runova/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { setElectronPath } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Studio's voice channels (E36) against the real service and desktop host: engine keys (the app's
 * OpenAI key, and Studio's own ElevenLabs key sealed with the vault), voices fetched through the
 * app's fetch, and narration runs. ffmpeg is absent here, so a run fails saying so; speaking
 * itself is covered in the package, with stand-in engines and ffmpeg.
 */

vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({ detect: vi.fn(async () => ({ state: 'absent' })) }),
}));
vi.mock('../studio/capture/offscreenSource', () => ({
  createOffscreenSource: vi.fn(),
  sceneWindowsMemoryBytes: () => 0,
}));

const userData = useTempUserData();
expectChannelsCovered(IPC.studioAudio);

const allowed = { value: true };
let server: Server;
const seenKeys: string[] = [];

beforeEach(async () => {
  allowed.value = true;
  seenKeys.length = 0;
  server = createServer((req, res) => {
    seenKeys.push(String(req.headers['xi-api-key']));
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(
      JSON.stringify({
        voices: [
          { voice_id: 'v1', name: 'Rachel' },
          { voice_id: 'v2', name: 'Yun', labels: { language: 'zh' } },
        ],
      }),
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  vi.stubEnv('RUNOVA_STUDIO_TTS_URL', `http://127.0.0.1:${(server.address() as AddressInfo).port}`);
  setElectronPath('videos', join(userData.dir, 'Videos'));
  userData.writeData('settings.json', { openaiApiKey: 'sk-app' });
  await loadIpc(
    () => import('./studio'),
    (m) => m.registerStudioHandlers({ guard: () => allowed.value }),
  );
  // The modules were loaded afresh, so the host sees this copy of the Electron stand-in.
  const { net } = (await import(
    'electron'
  )) as unknown as typeof import('../../test/main/electronMock');
  net.fetch.mockImplementation((url: string, init?: RequestInit) => fetch(url, init));
});

afterEach(async () => {
  const { shutdownStudio } = await import('../studio');
  await shutdownStudio();
  vi.unstubAllEnvs();
  await new Promise((resolve) => server.close(resolve));
});

async function openVideo(): Promise<string> {
  const video = await invoke<VideoSummary>(IPC.studio.create, {
    title: 'Launch',
    projectId: null,
    language: 'fa',
    aspect: '16:9',
  });
  const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  return video.id;
}

const problemOf = (engines: VoiceEngineView[], id: string) =>
  engines.find((e) => e.id === id)?.problem;

describe('voice channels', () => {
  it('uses the app OpenAI key, seals the ElevenLabs key, and lists its voices without Chinese ones', async () => {
    const engines = await invoke<VoiceEngineView[]>(IPC.studioAudio.engines);
    expect(problemOf(engines, 'openai')).toBeNull();
    expect(problemOf(engines, 'elevenlabs')).toBe('Add an ElevenLabs key in Settings > Studio.');

    const saved = await invoke<VoiceEngineView[]>(IPC.studioAudio.setKey, {
      engine: 'elevenlabs',
      key: 'xi-secret',
    });
    expect(problemOf(saved, 'elevenlabs')).toBeNull();
    const { readFileSync } = await import('node:fs');
    const file = readFileSync(join(userData.dir, 'data', 'studio', 'secrets.json'), 'utf8');
    expect(file).not.toContain('xi-secret');

    const voices = await invoke(IPC.studioAudio.voices, { engine: 'elevenlabs', lang: 'fa' });
    expect(voices).toEqual([{ id: 'v1', label: 'Rachel' }]);
    expect(seenKeys).toEqual(['xi-secret']);
    await expect(
      invoke(IPC.studioAudio.setKey, { engine: 'azure', key: 'k', region: 'West Europe' }),
    ).rejects.toThrow('That Studio request is not valid');
  });

  it('asks for the vault to be unlocked once a passkey seals the key', async () => {
    await invoke(IPC.studioAudio.setKey, { engine: 'azure', key: 'az', region: 'westeurope' });
    const vault = await import('../ssh/vault');
    expect((await vault.setPasskey('correct horse')).ok).toBe(true);
    vault.lockVault();
    const locked = await invoke<VoiceEngineView[]>(IPC.studioAudio.engines);
    expect(locked.find((e) => e.id === 'azure')).toMatchObject({
      locked: true,
      problem: 'Unlock the vault to use Azure Speech.',
    });
    expect(await vault.unlockVault('correct horse')).toBe(true);
    expect(problemOf(await invoke(IPC.studioAudio.engines), 'azure')).toBeNull();
  });

  it('starts a narration run that says ffmpeg is missing, and lists and cancels runs', async () => {
    const videoId = await openVideo();
    const session = await invoke<OpenVideoResult>(IPC.studio.open, { videoId });
    if (session.state !== 'open') throw new Error('not open');
    await invoke(IPC.studio.apply, {
      videoId,
      baseSeq: session.session.status.seq,
      ops: [
        {
          op: 'scene.add',
          index: 0,
          scene: createScene({ id: 's1', narration: 'سلام' }),
        },
      ],
      label: 'Scene',
    });
    const job = await invoke<NarrationJobView>(IPC.studioAudio.speak, {
      videoId,
      sceneIds: ['s1'],
      voiceRef: 'openai:marin',
    });
    await vi.waitFor(async () => {
      const [latest] = await invoke<NarrationJobView[]>(IPC.studioAudio.jobs, { videoId });
      expect(latest?.status).toBe('failed');
      expect(latest?.error).toMatch(/^Narration needs ffmpeg/);
    });
    await invoke(IPC.studioAudio.cancel, { videoId, jobId: job.id });
    await expect(
      invoke(IPC.studioAudio.speak, { videoId, sceneIds: ['s1'], voiceRef: 'nope:x' }),
    ).rejects.toThrow('Pick one of the offered voices.');
    await expect(
      invoke(IPC.studioAudio.captionScene, { videoId, sceneId: 's1' }),
    ).resolves.toMatchObject({
      document: { timeline: { clips: [expect.objectContaining({ trackId: 'track-text' })] } },
    });
    await expect(
      invoke(IPC.studioAudio.record, {
        videoId,
        sceneId: 's1',
        bytes: new Uint8Array([1, 2, 3]),
        mimeType: 'audio/webm',
      }),
    ).rejects.toThrow(/ffmpeg/);
  });

  it('lists voice profiles, needs ffmpeg for a take, and checks consent before making one', async () => {
    expect(await invoke(IPC.studioAudio.profiles)).toEqual([]);
    const take = { bytes: new Uint8Array([1, 2, 3]), mimeType: 'audio/webm' };
    await expect(invoke(IPC.studioAudio.transcribeTake, { ...take, lang: 'fa' })).rejects.toThrow(
      /^Voice profiles need ffmpeg/,
    );
    await expect(
      invoke(IPC.studioAudio.createProfile, {
        ...take,
        name: 'Me',
        lang: 'fa',
        transcript: '',
        consent: false,
      }),
    ).rejects.toThrow('That Studio request is not valid (consent)');
    await expect(
      invoke(IPC.studioAudio.createProfile, {
        ...take,
        name: 'Me',
        lang: 'fa',
        transcript: '',
        consent: true,
      }),
    ).rejects.toThrow(/^Voice profiles need ffmpeg/);
    for (const [channel, input] of [
      [IPC.studioAudio.updateProfile, { profileId: 'p1', name: 'X' }],
      [IPC.studioAudio.cloneProfile, { profileId: 'p1', acknowledgeUpload: true }],
      [IPC.studioAudio.removeProfile, { profileId: 'p1' }],
    ] as const) {
      await expect(invoke(channel, input)).rejects.toThrow(
        'That voice profile is not there any more.',
      );
    }
    await expect(invoke(IPC.studioAudio.cloneProfile, { profileId: 'p1' })).rejects.toThrow(
      'That Studio request is not valid (acknowledgeUpload)',
    );
  });

  it('answers only the main window', async () => {
    allowed.value = false;
    await expect(invokeFrom(fakeWebContents(), IPC.studioAudio.engines)).rejects.toThrow(
      'Studio only answers the main window.',
    );
  });
});
