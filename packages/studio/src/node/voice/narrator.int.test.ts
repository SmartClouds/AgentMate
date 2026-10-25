import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createScene } from '../../document/schema.js';
import { type FakeTtsServer, GOOD_KEY, startFakeTts } from '../../test/fakeTts.js';
import { realTools } from '../../test/ffmpegTools.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { secondsToFlicks } from '../../time/flicks.js';
import { parseWav } from '../../voice/wav.js';
import { createVideoFolder, VideoStore } from '../project/videoStore.js';
import { createNarrator } from './narrator.js';

/** Narration joined by the real ffmpeg: 24 kHz pieces from OpenAI become one 48 kHz file. */

const tools = realTools();
const tempDir = useTempDirs();
let server: FakeTtsServer;
beforeAll(async () => {
  server = await startFakeTts();
});
afterAll(async () => {
  await server.close();
});

describe.skipIf(!tools)('narration with the real ffmpeg', () => {
  it('joins 24 kHz pieces into one 48 kHz narration of the same length', async () => {
    const root = await tempDir();
    const { folder } = await createVideoFolder(
      root,
      { id: 'v1aaaaaaaaaaaaaa', title: 'T', language: 'en', linkedProjectId: null },
      { openDb: openNodeSqlite, now: () => 1 },
    );
    const store = await VideoStore.open(folder, {
      openDb: openNodeSqlite,
      now: () => 1,
      materializeDelayMs: 0,
    });
    const text = `${'A short sentence to say. '.repeat(30)}The end.`;
    store.apply({
      baseSeq: store.seq,
      ops: [{ op: 'scene.add', index: 0, scene: createScene({ id: 'a', narration: text }) }],
      label: 'Scene',
    });
    let n = 0;
    const narrator = createNarrator({
      tools: async () => tools,
      keys: async () => ({ openai: GOOD_KEY }),
      fetch,
      baseUrl: server.url,
      cacheDir: async () => join(root, 'voice'),
      store: () => store,
      afterEdit: async () => undefined,
      notify: () => undefined,
      newId: () => `id${++n}`,
      now: () => 1,
    });
    narrator.speak({ videoId: 'v1', sceneIds: ['a'], voiceRef: 'openai:marin' });
    await narrator.idle('v1');
    expect(narrator.jobs('v1')[0]).toMatchObject({ status: 'done', total: 2 });
    const [media] = store.mediaList();
    const wav = parseWav(await readFile(store.blobs.path(media?.hash as string)));
    expect(wav.sampleRate).toBe(48_000);
    // The fake speaks a twentieth of a second a character; two pieces, joined end to end.
    expect(wav.seconds).toBeGreaterThan(text.length * 0.05 - 0.2);
    expect(wav.seconds).toBeLessThan(text.length * 0.05 + 0.2);
    expect(media?.info.duration).toBe(secondsToFlicks(wav.frames / 48_000));
    await store.close();
  });
});
