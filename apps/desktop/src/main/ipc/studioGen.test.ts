import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { GenJobView, OpenVideoResult, VideoSummary } from '@runova/studio';
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
 * Studio's generated media channels (E38) against the real service and desktop host: the estimate,
 * the confirmation rule, and a generation that fails plainly without a key. Talking to the
 * providers is covered in the package, against fake servers in their documented shapes.
 */

vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({ detect: vi.fn(async () => ({ state: 'absent' })) }),
}));
vi.mock('../studio/capture/offscreenSource', () => ({
  createOffscreenSource: vi.fn(),
  sceneWindowsMemoryBytes: () => 0,
}));

const userData = useTempUserData();
expectChannelsCovered(IPC.studioGen);

const allowed = { value: true };

beforeEach(async () => {
  allowed.value = true;
  setElectronPath('videos', join(userData.dir, 'Videos'));
  await loadIpc(
    () => import('./studio'),
    (m) => m.registerStudioHandlers({ guard: () => allowed.value }),
  );
});

afterEach(async () => {
  const { shutdownStudio } = await import('../studio');
  await shutdownStudio();
});

async function openVideo(): Promise<string> {
  const video = await invoke<VideoSummary>(IPC.studio.create, {
    title: 'Gen',
    projectId: null,
    language: 'en',
    aspect: '16:9',
  });
  const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  return video.id;
}

describe('generated media channels', () => {
  it('estimates, refuses an unconfirmed price, and fails plainly without a key', async () => {
    const videoId = await openVideo();
    const ask = {
      videoId,
      kind: 'image',
      engine: 'openai',
      prompt: 'A red bicycle',
      quality: 'low',
    };
    expect(await invoke(IPC.studioGen.estimate, ask)).toMatchObject({
      usd: 0.006,
      model: 'gpt-image-2.5-flare',
    });
    await expect(invoke(IPC.studioGen.start, { ...ask, confirmedUsd: 1 })).rejects.toThrow(
      /^The price changed since you confirmed it/,
    );
    await expect(invoke(IPC.studioGen.start, ask)).rejects.toThrow(
      'That Studio request is not valid (confirmedUsd)',
    );
    const job = await invoke<GenJobView>(IPC.studioGen.start, { ...ask, confirmedUsd: 0.006 });
    await vi.waitFor(async () => {
      const [latest] = await invoke<GenJobView[]>(IPC.studioGen.jobs, { videoId });
      expect(latest).toMatchObject({
        id: job.id,
        status: 'failed',
        error: 'Add an OpenAI API key in Settings > AI first.',
      });
    });
    await invoke(IPC.studioGen.cancel, { jobId: job.id });
    await expect(
      invoke(IPC.studioGen.estimate, { ...ask, kind: 'video', engine: 'openai' }),
    ).rejects.toThrow('Clips are made by Google Gemini Omni only.');
  });

  it('picks generations up at startup even when there was never a render', async () => {
    const dataDir = join(userData.dir, 'data', 'studio');
    mkdirSync(dataDir, { recursive: true });
    writeFileSync(
      join(dataDir, 'generations.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'g0aaaaaaaaaaaaaa',
            videoId: 'v1aaaaaaaaaaaaaa',
            kind: 'video',
            engine: 'gemini',
            model: 'gemini-omni-1.1-flash',
            prompt: 'Waves',
            estimateUsd: 0.8,
            status: 'running',
            stage: 'request',
            file: null,
            output: join(userData.dir, 'clip.mp4'),
            mediaHash: null,
            mediaName: null,
            error: null,
            createdAt: 1,
            endedAt: null,
            resumed: false,
          },
        ],
      }),
    );
    const { resumeStudioRenders } = await import('../studio');
    await resumeStudioRenders(dataDir);
    const [job] = await invoke<GenJobView[]>(IPC.studioGen.jobs, { videoId: 'v1aaaaaaaaaaaaaa' });
    expect(job).toMatchObject({
      status: 'interrupted',
      error: expect.stringMatching(/may still have billed/),
    });
  });

  it('answers only the main window', async () => {
    allowed.value = false;
    await expect(
      invokeFrom(fakeWebContents(), IPC.studioGen.jobs, { videoId: 'v1aaaaaaaaaaaaaa' }),
    ).rejects.toThrow('Studio only answers the main window.');
  });
});
