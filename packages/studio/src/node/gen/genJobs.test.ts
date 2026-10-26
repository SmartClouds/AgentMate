import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../api.js';
import { type FakeGen, GEN_KEY, startFakeGen } from '../../test/fakeGen.js';
import { useTempDirs } from '../../test/tempDir.js';
import { createGenJobs } from './genJobs.js';

const PICTURE = Buffer.from('fake png bytes');
const CLIP = Buffer.from('fake mp4 bytes '.repeat(2000));
const tempDir = useTempDirs();
let gen: FakeGen;
beforeAll(async () => {
  gen = await startFakeGen({ picture: PICTURE, clip: CLIP, processingPolls: 2 });
});
afterAll(async () => {
  await gen.close();
});

async function setup(
  options: { root?: string; open?: boolean; keys?: Record<string, string> } = {},
) {
  const root = options.root ?? (await tempDir());
  const imported: { file: string; bytes: Buffer }[] = [];
  const events: StudioEvent[] = [];
  let n = 0;
  const jobs = createGenJobs({
    dataDir: join(root, 'data'),
    keys: async () => options.keys ?? { openai: GEN_KEY, gemini: GEN_KEY },
    fetch,
    baseUrl: gen.url,
    cacheDir: async (videoId) => join(root, 'cache', videoId),
    importFile: async (_videoId, file) => {
      if (options.open === false) return null;
      imported.push({ file, bytes: await readFile(file) });
      return { hash: `h${imported.length}`, name: file.split(/[\\/]/).pop() as string };
    },
    notify: (e) => events.push(e),
    newId: () => `g${++n}${Math.random().toString(36).slice(2, 6)}`,
    now: () => Date.now(),
    pollMs: 10,
  });
  return { root, jobs, imported, events };
}

const picture = (engine: 'openai' | 'gemini', prompt = 'A teapot on a table') => ({
  videoId: 'v1',
  kind: 'image' as const,
  engine,
  prompt,
});

describe('generated pictures', () => {
  it('makes a picture with each provider once its estimate is confirmed, into the media (AC1)', async () => {
    const { jobs, imported } = await setup();
    const openai = await jobs.start({ ...picture('openai'), quality: 'low', confirmedUsd: 0.006 });
    expect(openai.status).toBe('running');
    await jobs.start({ ...picture('gemini'), size: '1K', confirmedUsd: 0.0336 });
    await jobs.idle();
    const list = await jobs.jobs('v1');
    expect(list.map((j) => [j.engine, j.status, j.mediaName])).toEqual([
      ['gemini', 'done', 'Generated picture 2.png'],
      ['openai', 'done', 'Generated picture 1.png'],
    ]);
    expect(imported.map((i) => i.bytes.toString())).toEqual(['fake png bytes', 'fake png bytes']);
    const asked = gen.requests.find((r) => r.path === '/v1/images/generations');
    expect(JSON.parse(asked?.body ?? '{}')).toMatchObject({
      model: 'gpt-image-2.5-flare',
      quality: 'low',
      size: '1024x1024',
    });
  });

  it('sends nothing without a confirmation of the current estimate (AC3)', async () => {
    const { jobs } = await setup();
    const before = gen.requests.length;
    await expect(
      jobs.start({ ...picture('gemini'), size: '4K', confirmedUsd: 0.0336 }),
    ).rejects.toThrow('The price changed since you confirmed it.');
    await expect(
      jobs.start({
        videoId: 'v1',
        kind: 'video',
        engine: 'openai',
        prompt: 'x y z',
        confirmedUsd: 0.8,
      }),
    ).rejects.toThrow('Clips are made by Google Gemini Omni only.');
    expect(gen.requests.length).toBe(before);
    expect(await jobs.jobs('v1')).toEqual([]);
  });

  it('records a declined prompt in the provider own words, and a missing key', async () => {
    const { jobs } = await setup();
    await jobs.start({ ...picture('openai', 'REFUSE this'), confirmedUsd: 0.053 });
    await jobs.start({ ...picture('gemini', 'REFUSE that'), confirmedUsd: 0.0336 });
    await jobs.idle();
    const [gemini, openai] = await jobs.jobs('v1');
    expect(openai).toMatchObject({
      status: 'refused',
      error: 'OpenAI declined this prompt: Your request was rejected by the safety system.',
    });
    expect(gemini).toMatchObject({
      status: 'refused',
      error: 'Google Gemini declined this prompt: I cannot make that.',
    });
    const nokey = await setup({ keys: {} });
    await nokey.jobs.start({ ...picture('openai'), confirmedUsd: 0.053 });
    await nokey.jobs.idle();
    expect((await nokey.jobs.jobs('v1'))[0]).toMatchObject({
      status: 'failed',
      error: 'Add an OpenAI API key in Settings > AI first.',
    });
  });
});

describe('generated clips', () => {
  const clip = {
    videoId: 'v1',
    kind: 'video' as const,
    engine: 'gemini' as const,
    prompt: 'Waves on a beach',
    confirmedUsd: 0.8,
  };

  it('waits for the clip file, downloads it on through a drop, and imports it (AC1)', async () => {
    const { jobs, imported, events } = await setup();
    gen.dropNextDownload();
    await jobs.start(clip);
    await jobs.idle();
    const [job] = await jobs.jobs('v1');
    expect(job).toMatchObject({
      status: 'done',
      mediaName: 'Generated clip 1.mp4',
      model: 'gemini-omni-1.1-flash',
    });
    expect(imported[0]?.bytes.equals(CLIP)).toBe(true);
    const downloads = gen.requests.filter((r) => r.path.endsWith(':download'));
    // The second request carried on from where the first dropped.
    expect(downloads.length).toBe(2);
    expect(downloads[1]?.range).toMatch(/^bytes=\d+-$/);
    const asked = JSON.parse(gen.requests.find((r) => r.body.includes('"video"'))?.body ?? '{}');
    expect(asked.response_format).toMatchObject({
      type: 'video',
      delivery: 'uri',
      aspect_ratio: '16:9',
    });
    expect(events.filter((e) => e.type === 'gen-changed').length).toBeGreaterThan(3);
  });

  it('carries on polling and downloading after a restart (AC2), and keeps a closed video file', async () => {
    const root = await tempDir();
    const first = await setup({ root, open: false });
    await first.jobs.start(clip);
    // Quit while the clip is still being prepared.
    for (let i = 0; i < 200; i++) {
      if ((await first.jobs.jobs('v1'))[0]?.stage === 'waiting') break;
      await new Promise((r) => setTimeout(r, 5));
    }
    await first.jobs.shutdown();
    expect((await first.jobs.jobs('v1'))[0]).toMatchObject({ status: 'running', stage: 'waiting' });

    const second = await setup({ root, open: false });
    await second.jobs.resumeAfterStart();
    await second.jobs.idle();
    const [job] = await second.jobs.jobs('v1');
    expect(job).toMatchObject({ status: 'done', resumed: true, stage: 'import', mediaHash: null });

    // Opened again: the waiting file is imported.
    const third = await setup({ root });
    await third.jobs.importPending('v1');
    expect((await third.jobs.jobs('v1'))[0]).toMatchObject({ stage: null, mediaHash: 'h1' });
    expect(third.imported[0]?.bytes.equals(CLIP)).toBe(true);
  });

  it('marks a request cut off before the provider answered as interrupted, never sending it again', async () => {
    const root = await tempDir();
    const { writeFile, mkdir } = await import('node:fs/promises');
    await mkdir(join(root, 'data'), { recursive: true });
    await writeFile(
      join(root, 'data', 'generations.json'),
      JSON.stringify({
        version: 1,
        jobs: [
          {
            id: 'g0',
            videoId: 'v1',
            kind: 'video',
            engine: 'gemini',
            model: 'gemini-omni-1.1-flash',
            prompt: 'x',
            estimateUsd: 0.8,
            status: 'running',
            stage: 'request',
            file: null,
            output: join(root, 'out.mp4'),
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
    const { jobs } = await setup({ root });
    const before = gen.requests.length;
    await jobs.resumeAfterStart();
    expect((await jobs.jobs('v1'))[0]).toMatchObject({
      status: 'interrupted',
      error: expect.stringMatching(/may still have billed/),
    });
    expect(gen.requests.length).toBe(before);
  });

  it('cancels a clip that is waiting', async () => {
    const slow = await startFakeGen({ picture: PICTURE, clip: CLIP, processingPolls: 1000 });
    try {
      const root = await tempDir();
      const jobs = createGenJobs({
        dataDir: join(root, 'data'),
        keys: async () => ({ gemini: GEN_KEY }),
        fetch,
        baseUrl: slow.url,
        cacheDir: async () => join(root, 'cache'),
        importFile: async () => null,
        notify: () => undefined,
        newId: () => 'g1',
        now: () => Date.now(),
        pollMs: 10,
      });
      const job = await jobs.start(clip);
      await new Promise((r) => setTimeout(r, 100));
      await jobs.cancel(job.id);
      expect((await jobs.jobs('v1'))[0]?.status).toBe('cancelled');
    } finally {
      await slow.close();
    }
  });
});
