import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest';
import type { StudioEvent } from '../../api.js';
import { createScene } from '../../document/schema.js';
import { type FakeTtsServer, GOOD_KEY, startFakeTts, tonePcm } from '../../test/fakeTts.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { narratedLength } from '../../timeline/narration.js';
import { encodeWav } from '../../voice/wav.js';
import { createVideoFolder, VideoStore } from '../project/videoStore.js';
import type { FfmpegTools } from '../render/ffmpegTool.js';
import type { EngineKeys } from './engines.js';
import { createNarrator, type Narrator } from './narrator.js';

const tempDir = useTempDirs();
let server: FakeTtsServer;
beforeAll(async () => {
  server = await startFakeTts();
});
afterAll(async () => {
  await server.close();
});
const stores: VideoStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});

const KEYS: EngineKeys = { elevenlabs: GOOD_KEY, azure: { key: GOOD_KEY, region: 'westeurope' } };
// Fifteen short sentences, about 690 characters: two pieces for the engine.
const LONG = `${'Studio speaks this sentence slowly and clearly. '.repeat(14)}And this is the end.`;

async function setup(over: { tools?: FfmpegTools | null; keys?: EngineKeys } = {}) {
  const root = await tempDir();
  let n = 0;
  const { folder } = await createVideoFolder(
    root,
    { id: 'v1aaaaaaaaaaaaaa', title: 'T', language: 'fa', linkedProjectId: null },
    { openDb: openNodeSqlite, now: () => 1 },
  );
  const store = await VideoStore.open(folder, {
    openDb: openNodeSqlite,
    now: () => 1,
    materializeDelayMs: 0,
  });
  stores.push(store);
  store.apply({
    baseSeq: store.seq,
    ops: [
      {
        op: 'scene.add',
        index: 0,
        scene: createScene({
          id: 'a',
          narration: 'سلام. این یک آزمایش است.',
          targetDuration: secondsToFlicks(5),
        }),
      },
      {
        op: 'scene.add',
        index: 1,
        scene: createScene({ id: 'b', narration: LONG, targetDuration: secondsToFlicks(5) }),
      },
      {
        op: 'scene.add',
        index: 2,
        scene: createScene({ id: 'c', narration: '', targetDuration: secondsToFlicks(2) }),
      },
    ],
    label: 'Scenes',
  });
  const events: StudioEvent[] = [];
  const narrator: Narrator = createNarrator({
    tools: async () => (over.tools === undefined ? fakeTools : over.tools),
    keys: async () => over.keys ?? KEYS,
    fetch,
    baseUrl: server.url,
    cacheDir: async () => join(root, 'cache', 'voice'),
    store: () => store,
    afterEdit: async () => undefined,
    notify: (e) => events.push(e),
    newId: () => `id${String(++n).padStart(6, '0')}`,
    now: () => 1000 + n,
    retryDelaysMs: [1, 1, 1],
  });
  return { root, store, narrator, events };
}

const voiceClips = (store: VideoStore) =>
  store.document.timeline.clips.filter((c) => c.trackId === 'track-voice');

describe('narrating scenes', () => {
  it('speaks each scene, fits it to its voice and places the voice at its start', async () => {
    const { store, narrator, events } = await setup();
    const job = narrator.speak({
      videoId: 'v1',
      sceneIds: ['a', 'b', 'c'],
      voiceRef: 'azure:fa-IR-DilaraNeural',
    });
    expect(job.status).toBe('running');
    await narrator.idle('v1');
    const [done] = narrator.jobs('v1');
    expect(done).toMatchObject({
      status: 'done',
      total: 3,
      done: 3,
      reused: 0,
      skipped: ['c'],
      error: null,
    });
    const [a, b, c] = store.document.scenario.scenes;
    // The fake engine speaks a twentieth of a second a character.
    const aSeconds = 'سلام. این یک آزمایش است.'.length * 0.05;
    expect(a?.targetDuration).toBe(narratedLength(aSeconds, 30));
    expect(a?.voiceRef).toBe('azure:fa-IR-DilaraNeural');
    expect(c?.voiceRef).toBeNull();
    const clips = voiceClips(store);
    expect(clips.map((clip) => clip.start)).toEqual([0, a?.targetDuration]);
    expect(clips[0]?.duration).toBe(secondsToFlicks(aSeconds));
    expect(clips[0]?.id).toMatch(/^nv-a-/);
    expect(b?.targetDuration).toBeGreaterThan(secondsToFlicks(20));
    expect(
      store
        .mediaList()
        .map((m) => m.name)
        .sort(),
    ).toEqual(['Narration, scene 1.wav', 'Narration, scene 2.wav']);
    expect(events.filter((e) => e.type === 'narration-changed').length).toBeGreaterThan(3);
    // One undo takes back one scene's narration.
    store.undo();
    expect(voiceClips(store)).toHaveLength(1);
  });

  it('keeps the length of a scene set to a fixed length, and replaces an earlier narration', async () => {
    const { store, narrator } = await setup();
    store.apply({
      baseSeq: store.seq,
      ops: [{ op: 'scene.update', sceneId: 'a', patch: { timing: 'fixed' } }],
      label: 'Fixed',
    });
    narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'azure:fa-IR-DilaraNeural' });
    await narrator.idle('v1');
    narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'azure:fa-IR-FaridNeural' });
    await narrator.idle('v1');
    expect(store.document.scenario.scenes[0]?.targetDuration).toBe(secondsToFlicks(5));
    expect(voiceClips(store)).toHaveLength(1);
    expect(store.document.scenario.scenes[0]?.voiceRef).toBe('azure:fa-IR-FaridNeural');
  });

  it('after a failure part way, speaks only the pieces still missing (AC3)', async () => {
    const { store, narrator } = await setup();
    // The first piece of scene b goes through, then the engine refuses for good.
    let requests = 0;
    const before = server.requests.length;
    narrator.speak({ videoId: 'v1', sceneIds: ['b'], voiceRef: 'elevenlabs:v-rachel' });
    const watch = setInterval(() => {
      requests = server.requests.length - before;
      if (requests >= 1) server.failNext(100, 400);
    }, 1);
    await narrator.idle('v1');
    clearInterval(watch);
    server.failNext(0, 400);
    const [failed] = narrator.jobs('v1');
    expect(failed?.status).toBe('failed');
    expect(failed?.error).toMatch(/^ElevenLabs answered 400/);
    expect(voiceClips(store)).toHaveLength(0);

    const spokenBefore = server.requests.length;
    narrator.speak({ videoId: 'v1', sceneIds: ['b'], voiceRef: 'elevenlabs:v-rachel' });
    await narrator.idle('v1');
    const [resumed] = narrator.jobs('v1');
    expect(resumed).toMatchObject({ status: 'done', total: 2, reused: 1 });
    expect(server.requests.length - spokenBefore).toBe(1);
    expect(voiceClips(store)).toHaveLength(1);
  });

  it('tries again after rate limits, and fails plainly on a refused key', async () => {
    const { narrator } = await setup();
    server.failNext(2, 503);
    narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'azure:fa-IR-DilaraNeural' });
    await narrator.idle('v1');
    expect(narrator.jobs('v1')[0]?.status).toBe('done');

    const refused = await setup({ keys: { azure: { key: 'wrong', region: 'x' } } });
    refused.narrator.speak({
      videoId: 'v1',
      sceneIds: ['a'],
      voiceRef: 'azure:fa-IR-DilaraNeural',
    });
    await refused.narrator.idle('v1');
    expect(refused.narrator.jobs('v1')[0]).toMatchObject({
      status: 'failed',
      error: expect.stringMatching(/^Azure Speech refused the key/),
    });
  });

  it('cancels a run, refuses a second run at once, a voice it does not know, and works without ffmpeg only to say so', async () => {
    const { narrator } = await setup();
    const job = narrator.speak({ videoId: 'v1', sceneIds: ['b'], voiceRef: 'elevenlabs:v-rachel' });
    expect(() =>
      narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'elevenlabs:v-rachel' }),
    ).toThrow('This video is already being narrated.');
    narrator.cancel('v1', job.id);
    await narrator.idle('v1');
    expect(narrator.jobs('v1')[0]?.status).toBe('cancelled');
    expect(() => narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'nope' })).toThrow(
      'Pick one of the offered voices.',
    );

    const bare = await setup({ tools: null });
    bare.narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'azure:fa-IR-DilaraNeural' });
    await bare.narrator.idle('v1');
    expect(bare.narrator.jobs('v1')[0]?.error).toMatch(/^Narration needs ffmpeg/);
    await bare.narrator.shutdown();
  });
});

describe('recordings and captions', () => {
  it('puts a recording on a scene as its narration', async () => {
    const { root, store, narrator } = await setup();
    const file = join(root, 'take.wav');
    await writeFile(file, encodeWav(tonePcm(1.5, 48_000), 48_000));
    await narrator.placeRecording({ videoId: 'v1', sceneId: 'a', file });
    expect(store.document.scenario.scenes[0]).toMatchObject({
      voiceRef: 'recording',
      targetDuration: narratedLength(1.5, 30),
    });
    expect(voiceClips(store)[0]?.duration).toBe(secondsToFlicks(1.5));
    await expect(narrator.placeRecording({ videoId: 'v1', sceneId: 'zz', file })).rejects.toThrow(
      'That scene is not in the video any more.',
    );
  });

  it('captions a scene where its words are spoken, and refuses to caption twice', async () => {
    const { store, narrator } = await setup();
    narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'elevenlabs:v-rachel' });
    await narrator.idle('v1');
    await narrator.captionScene({ videoId: 'v1', sceneId: 'a' });
    const captions = store.document.timeline.clips.filter((c) => c.trackId === 'track-text');
    expect(captions.map((c) => c.source.type === 'text' && c.source.text)).toEqual([
      'سلام.',
      'این یک آزمایش است.',
    ]);
    expect(captions[0]?.start).toBe(0);
    // The second line starts where its first word is spoken: after "سلام. " (6 characters).
    expect(captions[1]?.start).toBe(secondsToFlicks(Math.round(6 * 0.05 * 30) / 30));
    expect(captions.every((c) => c.id.startsWith('nc-a-'))).toBe(true);
    expect(store.history({ limit: 1 })[0]?.label).toBe('Captioned scene 1 from its voice');
    await expect(narrator.captionScene({ videoId: 'v1', sceneId: 'a' })).rejects.toThrow(
      'There are captions over scene 1 already; remove them first.',
    );
    await expect(narrator.captionScene({ videoId: 'v1', sceneId: 'c' })).rejects.toThrow(
      'Scene 3 has no narration to caption.',
    );
  });

  it('captions a scene without a voice by the length of its lines', async () => {
    const { store, narrator } = await setup();
    await narrator.captionScene({ videoId: 'v1', sceneId: 'a' });
    expect(store.history({ limit: 1 })[0]?.label).toBe('Captioned scene 1');
    expect(store.document.timeline.clips.filter((c) => c.trackId === 'track-text')).toHaveLength(2);
  });
});
