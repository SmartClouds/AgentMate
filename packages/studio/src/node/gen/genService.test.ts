import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import { fakeFrameHost } from '../../test/fakeFrames.js';
import { type FakeGen, GEN_KEY, startFakeGen } from '../../test/fakeGen.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { createStudioService, type StudioService } from '../service.js';

/**
 * Generated media through the service (E38): the estimate first, then a picture and a clip into
 * the open video's media library, and a clip that finished while the video was closed imported
 * when it opens. The stand-in ffprobe reads what a "file" is from its JSON.
 */

const PICTURE = Buffer.from(
  JSON.stringify({
    probe: {
      format: { format_name: 'png_pipe' },
      streams: [
        {
          codec_type: 'video',
          width: 1024,
          height: 1024,
          avg_frame_rate: '25/1',
          disposition: { attached_pic: 0 },
        },
      ],
    },
  }),
);
const CLIP = Buffer.from(
  JSON.stringify({
    probe: {
      format: { duration: '8.000000', format_name: 'mov,mp4' },
      streams: [
        {
          codec_type: 'video',
          width: 1280,
          height: 720,
          avg_frame_rate: '24/1',
          disposition: { attached_pic: 0 },
        },
        { codec_type: 'audio', disposition: { attached_pic: 0 } },
      ],
    },
  }),
);

const tempDir = useTempDirs();
let gen: FakeGen;
beforeAll(async () => {
  gen = await startFakeGen({ picture: PICTURE, clip: CLIP, processingPolls: 1 });
});
afterAll(async () => {
  await gen.close();
});
const services: StudioService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

async function setup() {
  const root = await tempDir();
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
      appKeys: async () => ({ openai: GEN_KEY, gemini: GEN_KEY }),
      secrets: { get: async () => null, set: async () => undefined, isLocked: async () => false },
      fetch,
      baseUrl: gen.url,
    },
  });
  services.push(service);
  const video = await service.create({
    title: 'Gen',
    projectId: null,
    language: 'en',
    aspect: '16:9',
  });
  await service.open({ videoId: video.id });
  return { service, videoId: video.id };
}

async function settled(service: StudioService, videoId: string) {
  for (let i = 0; i < 1000; i++) {
    const jobs = await service.genJobs({ videoId });
    if (jobs.length > 0 && jobs.every((j) => j.status !== 'running')) return jobs;
    await new Promise((r) => setTimeout(r, 10));
  }
  throw new Error('generation did not finish');
}

describe('generated media through the service', () => {
  it('estimates first, then brings a picture and a clip into the video media (AC1)', async () => {
    const { service, videoId } = await setup();
    const estimate = await service.genEstimate({
      videoId,
      kind: 'image',
      engine: 'gemini',
      prompt: 'A red bicycle',
      size: '1K',
    });
    expect(estimate).toMatchObject({ usd: 0.0336, model: 'gemini-nano-banana-2.1' });
    await service.startGen({
      videoId,
      kind: 'image',
      engine: 'gemini',
      prompt: 'A red bicycle',
      size: '1K',
      confirmedUsd: estimate.usd,
    });
    await service.startGen({
      videoId,
      kind: 'video',
      engine: 'gemini',
      prompt: 'A bicycle ride',
      confirmedUsd: 0.8,
    });
    const jobs = await settled(service, videoId);
    expect(jobs.map((j) => [j.kind, j.status])).toEqual([
      ['video', 'done'],
      ['image', 'done'],
    ]);
    const media = await service.media({ videoId });
    expect(media.map((m) => [m.name, m.kind]).sort()).toEqual([
      ['Generated clip 1.mp4', 'video'],
      ['Generated picture 1.png', 'image'],
    ]);
    expect(jobs.every((j) => j.mediaHash && media.some((m) => m.hash === j.mediaHash))).toBe(true);
  });

  it('refuses to start for a video that is not open, or without the confirmed price', async () => {
    const { service, videoId } = await setup();
    await expect(
      service.startGen({
        videoId: 'closed00000000ab',
        kind: 'image',
        engine: 'openai',
        prompt: 'abc',
        confirmedUsd: 0.053,
      }),
    ).rejects.toThrow('That video is not open.');
    await expect(
      service.startGen({
        videoId,
        kind: 'image',
        engine: 'openai',
        prompt: 'abc',
        quality: 'high',
        confirmedUsd: 0.053,
      }),
    ).rejects.toThrow(/^The price changed/);
  });
});
