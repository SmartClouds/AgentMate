import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type {
  OpenVideoResult,
  RenderEstimateView,
  RenderJobView,
  RenderToolsView,
  VideoSummary,
} from '@runova/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState, setElectronPath } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Studio's render channels (E34) against the real service and desktop host. ffmpeg is played by
 * Dev Setup's answer: absent here, so a render fails with the way to install it. The renders
 * themselves are covered in the package against a stand-in ffmpeg and the real one.
 */

const detections = vi.hoisted(() => ({ ffmpeg: { state: 'absent' } as Record<string, unknown> }));
vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({
    detect: vi.fn(async (id: string) =>
      id === 'ffmpeg' ? detections.ffmpeg : { state: 'absent' },
    ),
  }),
}));
vi.mock('../studio/capture/offscreenSource', () => ({
  createOffscreenSource: vi.fn(),
  sceneWindowsMemoryBytes: () => 0,
}));

const userData = useTempUserData();
expectChannelsCovered(IPC.studioRender);

const allowed = { value: true };

beforeEach(async () => {
  allowed.value = true;
  detections.ffmpeg = { state: 'absent' };
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

async function openVideo() {
  const video = await invoke<VideoSummary>(IPC.studio.create, {
    title: 'Launch',
    projectId: null,
    language: 'en',
    aspect: '16:9',
  });
  const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  return { video, session: opened.session };
}

async function settled(jobId: string): Promise<RenderJobView> {
  let job: RenderJobView | undefined;
  await vi.waitFor(async () => {
    job = (await invoke<RenderJobView[]>(IPC.studioRender.jobs, {})).find((j) => j.id === jobId);
    expect(job?.status).not.toBe('queued');
    expect(job?.status).not.toBe('running');
  });
  return job as RenderJobView;
}

function doneJob(output: string, status = 'done') {
  return {
    id: 'job1',
    videoId: 'v1',
    title: 'Launch',
    fileName: 'Launch.mp4',
    folder: join(output, '..'),
    target: output,
    status,
    phase: null,
    done: 30,
    total: 30,
    plan: {
      width: 1920,
      height: 1080,
      design: { width: 1920, height: 1080 },
      scale: 1,
      fps: 30,
      settings: {
        aspect: '16:9',
        resolution: '1080p',
        fps: 30,
        quality: 'standard',
        codec: 'h264',
        hwEncode: false,
        audio: { sampleRate: 48_000, lufs: -14 },
      },
      scenes: [],
      transitions: [],
      totalFrames: 30,
      captureFrames: 30,
    },
    allowedHosts: [],
    output: status === 'done' ? output : null,
    error: null,
    createdAt: 1,
    startedAt: 1,
    endedAt: status === 'done' ? 2 : null,
    resumed: false,
    reusedChunks: 0,
    capturedChunks: 1,
    hardware: null,
  };
}

function writeRenders(jobs: unknown[]) {
  const dir = join(userData.dir, 'data', 'studio');
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, 'renders.json'), JSON.stringify({ version: 1, jobs }));
}

describe('render channels', () => {
  it('says ffmpeg is missing and what each codec needs', async () => {
    const tools = await invoke<RenderToolsView>(IPC.studioRender.tools);
    expect(tools.ffmpeg).toEqual({ found: false, version: null });
    expect(tools.codecs.h264).toBe(
      'ffmpeg is not installed. Install it from Agent Tools, Dev Setup (Studio), then try again.',
    );
  });

  it('estimates an open video, or says what blocks it', async () => {
    const { video } = await openVideo();
    const blocked = await invoke<RenderEstimateView>(IPC.studioRender.estimate, {
      videoId: video.id,
    });
    expect(blocked).toEqual({ ok: false, problems: ['The video has no scenes yet.'] });
    await expect(invoke(IPC.studioRender.estimate, { videoId: 'not valid!' })).rejects.toThrow(
      'That Studio request is not valid (videoId)',
    );
  });

  it('queues a render, fails it with the way to install ffmpeg, retries and removes it', async () => {
    const { video, session } = await openVideo();
    await invoke(IPC.studio.apply, {
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [
        {
          op: 'scene.add',
          index: 0,
          scene: {
            id: 's1',
            title: '',
            narration: '',
            onScreenText: [],
            targetDuration: 705_600_000,
            timing: 'fixed',
            visualKind: 'motion',
            visualBrief: '',
            transitionOut: null,
            musicCue: '',
            voiceRef: null,
            notes: '',
            code: { treeHash: 'a'.repeat(64) },
            params: {},
          },
        },
      ],
      label: 'Scene',
    });
    const job = await invoke<RenderJobView>(IPC.studioRender.start, {
      videoId: video.id,
      fileName: 'Teaser',
    });
    expect(job).toMatchObject({
      status: 'queued',
      fileName: 'Teaser.mp4',
      width: 1920,
      height: 1080,
    });
    const failed = await settled(job.id);
    expect(failed.error).toContain('ffmpeg is not installed');
    expect(
      await invoke<RenderJobView[]>(IPC.studioRender.jobs, { videoId: video.id }),
    ).toHaveLength(1);
    expect(await invoke<RenderJobView[]>(IPC.studioRender.jobs)).toHaveLength(1);

    await invoke(IPC.studioRender.retry, { jobId: job.id });
    expect((await settled(job.id)).status).toBe('failed');
    await invoke(IPC.studioRender.cancel, { jobId: job.id });
    await expect(invoke(IPC.studioRender.reveal, { jobId: job.id })).rejects.toThrow(
      'That render has no finished file.',
    );
    await invoke(IPC.studioRender.remove, { jobId: job.id });
    expect(await invoke<RenderJobView[]>(IPC.studioRender.jobs, {})).toEqual([]);
  });

  it('shows and opens a finished file from its own record, never a path from the page', async () => {
    const output = join(userData.dir, 'Videos', 'Launch.mp4');
    mkdirSync(join(userData.dir, 'Videos'), { recursive: true });
    writeFileSync(output, 'video');
    writeRenders([doneJob(output)]);
    await invoke(IPC.studioRender.reveal, { jobId: 'job1' });
    await invoke(IPC.studioRender.openFile, { jobId: 'job1' });
    expect(electronState.openedPaths).toEqual([output, output]);
  });

  it('answers only the main window', async () => {
    allowed.value = false;
    await expect(invokeFrom(fakeWebContents(), IPC.studioRender.tools)).rejects.toThrow(
      'Studio only answers the main window.',
    );
  });
});

describe('resuming renders at startup', () => {
  it('does nothing without a render list, and picks up a render a crash left running', async () => {
    const { resumeStudioRenders } = await import('../studio');
    const dataDir = join(userData.dir, 'data', 'studio');
    await resumeStudioRenders(dataDir);
    expect(await invoke<RenderJobView[]>(IPC.studioRender.jobs, {})).toEqual([]);

    writeRenders([doneJob(join(userData.dir, 'Videos', 'Launch.mp4'), 'running')]);
    await resumeStudioRenders(dataDir);
    // Resumed, then failed here only because this machine has no ffmpeg.
    const job = await settled('job1');
    expect(job).toMatchObject({ resumed: true, status: 'failed' });
  });
});
