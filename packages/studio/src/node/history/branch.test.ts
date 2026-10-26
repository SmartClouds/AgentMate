import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createDocument, createScene } from '../../document/schema.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { createVideoFolder, VideoStore } from '../project/videoStore.js';
import { treeFromFiles } from '../scenes/codeTree.js';
import { seedBranch } from './branch.js';

/** Seeding a new video from a version of another: the document and the files that version uses. */

const tempDir = useTempDirs();
const stores: VideoStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});

async function store(root: string, id: string) {
  const deps = { openDb: openNodeSqlite, now: () => 1 };
  const { folder } = await createVideoFolder(
    root,
    { id, title: 'T', language: 'fa', linkedProjectId: null },
    deps,
  );
  const opened = await VideoStore.open(folder, { ...deps, materializeDelayMs: 0 });
  stores.push(opened);
  return opened;
}

const info = {
  duration: 705_600_000,
  width: null,
  height: null,
  fps: null,
  hasAudio: true,
  hasVideo: false,
};

describe('seedBranch', () => {
  it('copies the media a version uses with its word timings, and its code trees', async () => {
    const root = await tempDir();
    const source = await store(root, 'srcaaaaaaaaaaaaa');
    const voice = await source.blobs.put('voice bytes');
    const words = await source.blobs.put('[{"word":"سلام","start":0,"end":0.4}]');
    const lost = await source.blobs.put('a clip whose record is gone');
    source.addMedia({
      hash: voice,
      name: 'Narration, scene 1.wav',
      kind: 'audio',
      info,
      bytes: 11,
      importedAt: 1,
    });
    source.setNarrationWords(voice, words);
    const tree = await treeFromFiles(
      [{ path: 'index.html', content: '<p>سلام</p>' }],
      source.blobs,
    );
    const doc = createDocument({ id: 'srcaaaaaaaaaaaaa', title: 'Source', language: 'fa' });
    doc.scenario.scenes = [
      createScene({ id: 'a', code: { treeHash: tree.treeHash } }),
      createScene({ id: 'b' }),
    ];
    const clip = (id: string, hash: string) => ({
      id,
      trackId: 'track-voice',
      start: 0,
      duration: 705_600_000,
      source: { type: 'media' as const, hash, in: 0, out: 705_600_000 },
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    });
    doc.timeline.clips = [
      clip('v', voice),
      clip('x', lost),
      { ...clip('s', voice), trackId: 'track-scene', source: { type: 'scene', sceneId: 'b' } },
    ];

    const target = await store(root, 'dstaaaaaaaaaaaaa');
    await seedBranch({ source, document: doc, target, id: 'dstaaaaaaaaaaaaa', title: 'Copy' });
    expect(target.document).toMatchObject({ id: 'dstaaaaaaaaaaaaa', title: 'Copy' });
    expect(target.mediaList().map((m) => m.name)).toEqual(['Narration, scene 1.wav']);
    expect(target.narrationWords(voice)).toBe(words);
    expect(await target.blobs.text(words)).toContain('سلام');
    expect(await target.blobs.text(tree.treeHash)).toContain('index.html');
    // A clip whose file has no record any more is left as it is, its file not copied.
    await expect(target.blobs.text(lost)).rejects.toThrow();
    expect(target.history({ limit: 1 })[0]?.label).toBe('Started from Source');
    expect(join(target.blobs.path(voice))).toContain('dstaaaaa');
  });
});
