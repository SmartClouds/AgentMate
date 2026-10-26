import { readdir, readFile, writeFile } from 'node:fs/promises';
import { basename, join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { OpError } from '../../document/ops.js';
import { createDocument, createScene } from '../../document/schema.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { HistoryDb } from '../db/history.js';
import { treeFromFiles } from '../scenes/codeTree.js';
import {
  createVideoFolder,
  DOCUMENT_FILE,
  MANIFEST_FILE,
  StaleEditError,
  VideoStore,
  type VideoStoreDeps,
} from './videoStore.js';

const tempDir = useTempDirs();
const stores: VideoStore[] = [];
afterEach(async () => {
  await Promise.all(stores.splice(0).map((s) => s.close()));
});

let clock = 1_700_000_000_000;
function deps(over: Partial<VideoStoreDeps> = {}): VideoStoreDeps {
  return { openDb: openNodeSqlite, now: () => clock++, materializeDelayMs: 0, ...over };
}

async function newVideo(over: Partial<VideoStoreDeps> = {}) {
  const root = await tempDir();
  const { folder } = await createVideoFolder(
    root,
    { id: 'abcdef1234567890', title: 'Launch film', language: 'fa', linkedProjectId: 'p1' },
    deps(over),
  );
  return { root, folder };
}

async function open(folder: string, over: Partial<VideoStoreDeps> = {}) {
  const store = await VideoStore.open(folder, deps(over));
  stores.push(store);
  return store;
}

const addScene = (id: string, index = 99) => ({
  op: 'scene.add' as const,
  scene: createScene({ id, title: id }),
  index,
});

describe('createVideoFolder', () => {
  it('makes a named folder with the manifest, the history and the current document', async () => {
    const { root, folder } = await newVideo();
    expect(basename(folder)).toBe('Launch-film-abcdef12');
    expect(await readdir(root)).toEqual(['Launch-film-abcdef12']);
    expect((await readdir(folder)).sort()).toEqual(
      [DOCUMENT_FILE, MANIFEST_FILE, 'studio.db'].sort(),
    );
    const manifest = JSON.parse(await readFile(join(folder, MANIFEST_FILE), 'utf8'));
    expect(manifest).toMatchObject({
      formatVersion: 1,
      id: 'abcdef1234567890',
      title: 'Launch film',
      linkedProjectId: 'p1',
    });
  });

  it('opens to an empty video in the chosen language, with "Video created" as the first entry', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    expect(store.document).toEqual(
      createDocument({ id: 'abcdef1234567890', title: 'Launch film', language: 'fa' }),
    );
    expect(store.seq).toBe(1);
    expect(store.history({ limit: 5 }).map((e) => e.label)).toEqual(['Video created']);
    expect(store.status()).toMatchObject({ canUndo: false, canRedo: false });
  });

  it('creates the storage folder when it does not exist yet', async () => {
    const root = join(await tempDir(), 'Runova Studio', 'My project');
    const { folder } = await createVideoFolder(
      root,
      { id: 'abcdef1234567890', title: 'Film', language: 'en', linkedProjectId: null },
      deps(),
    );
    expect(folder.startsWith(root)).toBe(true);
  });

  it('never reuses a folder that already exists', async () => {
    const root = await tempDir();
    const input = { id: 'abcdef1234567890', title: 'Film', language: 'en', linkedProjectId: null };
    await createVideoFolder(root, input, deps());
    await expect(createVideoFolder(root, input, deps())).rejects.toThrow(/already exists/);
  });
});

describe('VideoStore editing', () => {
  it('applies an edit, numbers it and keeps it after a reopen', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    const result = store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'Added a scene' });
    expect(result.seq).toBe(2);
    expect(result.document.scenario.scenes.map((s) => s.id)).toEqual(['s1']);
    await store.close();
    stores.pop();
    const again = await open(folder);
    expect(again.document.scenario.scenes.map((s) => s.id)).toEqual(['s1']);
    expect(again.seq).toBe(2);
  });

  it('refuses an edit made against an older version, so a stale editor cannot overwrite an AI change', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'one' });
    expect(() => store.apply({ baseSeq: 1, ops: [addScene('s2')], label: 'two' })).toThrow(
      StaleEditError,
    );
    expect(store.seq).toBe(2);
  });

  it('writes nothing for an edit that does not fit', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    expect(() =>
      store.apply({ baseSeq: 1, ops: [{ op: 'scene.remove', sceneId: 'nope' }], label: 'bad' }),
    ).toThrow(OpError);
    expect(store.seq).toBe(1);
  });

  it('ignores an empty edit', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    expect(store.apply({ baseSeq: 1, ops: [], label: 'nothing' }).seq).toBe(1);
  });

  it('records who made a change and which AI generation it came from', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({
      baseSeq: 1,
      ops: [addScene('s1')],
      label: 'AI wrote a scene',
      actor: 'ai',
      generationId: 'g1',
    });
    expect(store.history({ limit: 1 })[0]).toMatchObject({ actor: 'ai', generationId: 'g1' });
  });

  it('keeps the manifest title in step with the document title', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({
      baseSeq: 1,
      ops: [{ op: 'doc.set', field: 'title', value: 'فیلم معرفی' }],
      label: 'Renamed',
    });
    await store.flush();
    const manifest = JSON.parse(await readFile(join(folder, MANIFEST_FILE), 'utf8'));
    expect(manifest.title).toBe('فیلم معرفی');
    expect(store.manifest.title).toBe('فیلم معرفی');
  });
});

describe('VideoStore undo and redo', () => {
  it('undoes and redoes, naming what it will undo', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'Added scene 1' });
    store.apply({ baseSeq: 2, ops: [addScene('s2')], label: 'Added scene 2' });
    expect(store.status()).toMatchObject({
      canUndo: true,
      undoLabel: 'Added scene 2',
      canRedo: false,
    });

    store.undo();
    expect(store.document.scenario.scenes.map((s) => s.id)).toEqual(['s1']);
    expect(store.status()).toMatchObject({
      undoLabel: 'Added scene 1',
      redoLabel: 'Added scene 2',
    });

    store.redo();
    expect(store.document.scenario.scenes.map((s) => s.id)).toEqual(['s1', 's2']);
    expect(store.history({ limit: 3 }).map((e) => e.label)).toEqual([
      'Redo: Added scene 2',
      'Undo: Added scene 2',
      'Added scene 2',
    ]);
  });

  it('keeps undo working after the app restarts', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'Added scene 1' });
    await store.close();
    stores.pop();
    const again = await open(folder);
    expect(again.status().canUndo).toBe(true);
    again.undo();
    expect(again.document.scenario.scenes).toEqual([]);
  });

  it('does nothing when there is nothing to undo or redo', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    expect(store.undo()).toBeNull();
    expect(store.redo()).toBeNull();
    expect(store.seq).toBe(1);
  });
});

describe('VideoStore versions', () => {
  it('rebuilds any earlier version, across snapshots', async () => {
    const { folder } = await newVideo({ snapshotEvery: 3 });
    const store = await open(folder, { snapshotEvery: 3 });
    for (let i = 1; i <= 8; i += 1) {
      store.apply({ baseSeq: store.seq, ops: [addScene(`s${i}`)], label: `Scene ${i}` });
    }
    for (let seq = 1; seq <= store.seq; seq += 1) {
      expect(store.documentAt(seq).scenario.scenes).toHaveLength(seq - 1);
    }
  });

  it('takes snapshots as it goes, so a long history opens quickly', async () => {
    const { folder } = await newVideo();
    const store = await open(folder, { snapshotEvery: 2 });
    for (let i = 1; i <= 4; i += 1)
      store.apply({ baseSeq: store.seq, ops: [addScene(`s${i}`)], label: 'x' });
    await store.close();
    stores.pop();
    const db = HistoryDb.open(openNodeSqlite, join(folder, 'studio.db'));
    expect(db.lastSnapshotSeq()).toBeGreaterThanOrEqual(4);
    db.close();
  });

  it('restores an earlier version as a new entry, which can itself be undone', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'one' });
    store.apply({ baseSeq: 2, ops: [addScene('s2')], label: 'two' });
    store.restore(2);
    expect(store.document.scenario.scenes.map((s) => s.id)).toEqual(['s1']);
    expect(store.seq).toBe(4);
    expect(store.history({ limit: 1 })[0]?.label).toBe('Restored version 2');
    expect(store.revisions().at(-1)).toMatchObject({ seq: 4, kind: 'restore' });
    store.undo();
    expect(store.document.scenario.scenes.map((s) => s.id)).toEqual(['s1', 's2']);
  });

  it('refuses a version that does not exist', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    expect(() => store.documentAt(9)).toThrow(/version 9/);
    expect(() => store.restore(0)).toThrow(/version 0/);
  });
});

describe('VideoStore on disk', () => {
  it('writes document.json for the current version', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'one' });
    await store.flush();
    const saved = JSON.parse(await readFile(join(folder, DOCUMENT_FILE), 'utf8'));
    expect(saved.revision).toBe(2);
    expect(saved.document.scenario.scenes).toHaveLength(1);
  });

  it('loses no acknowledged edit when the app dies before document.json is written', async () => {
    const { folder } = await newVideo();
    const store = await open(folder, { materializeDelayMs: 60_000 });
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'one' });
    store.apply({ baseSeq: 2, ops: [addScene('s2')], label: 'two' });
    store.crashForTest();
    stores.pop();

    const again = await open(folder);
    expect(again.document.scenario.scenes.map((s) => s.id)).toEqual(['s1', 's2']);
    const saved = JSON.parse(await readFile(join(folder, DOCUMENT_FILE), 'utf8'));
    expect(saved.revision).toBe(3);
  });

  it('repairs a torn document.json from the history', async () => {
    const { folder } = await newVideo();
    await writeFile(join(folder, DOCUMENT_FILE), '{"revision": 1, "docu');
    const store = await open(folder);
    await store.flush();
    const saved = JSON.parse(await readFile(join(folder, DOCUMENT_FILE), 'utf8'));
    expect(saved.revision).toBe(1);
  });

  it('rebuilds the history from document.json when the history file was lost', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'one' });
    await store.close();
    stores.pop();
    const { rm } = await import('node:fs/promises');
    await rm(join(folder, 'studio.db'));

    const again = await open(folder);
    expect(again.document.scenario.scenes.map((s) => s.id)).toEqual(['s1']);
    expect(again.history({ limit: 5 }).map((e) => e.label)).toEqual([
      'Recovered from document.json',
    ]);
  });

  it('says so plainly when a folder is not a Studio video', async () => {
    const dir = await tempDir();
    await expect(VideoStore.open(dir, deps())).rejects.toThrow(/not a Studio video folder/);
    await writeFile(join(dir, MANIFEST_FILE), '{"oops":');
    await expect(VideoStore.open(dir, deps())).rejects.toThrow(/not a Studio video folder/);
  });

  it('refuses to open a video with no history and no document to rebuild it from', async () => {
    const { folder } = await newVideo();
    const { rm } = await import('node:fs/promises');
    await rm(join(folder, 'studio.db'));
    await rm(join(folder, DOCUMENT_FILE));
    await expect(VideoStore.open(folder, deps())).rejects.toThrow(/history is missing/);
  });

  it('writes nothing more after it is closed', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    await store.close();
    stores.pop();
    expect(() => store.apply({ baseSeq: 1, ops: [addScene('s1')], label: 'late' })).toThrow(
      /closed/,
    );
  });
});

describe('VideoStore scene code', () => {
  async function withScene() {
    const { folder } = await newVideo();
    const store = await open(folder);
    store.apply({ baseSeq: store.seq, ops: [addScene('s1', 0)], label: 'Added a scene' });
    const tree = await treeFromFiles(
      [
        { path: 'index.html', content: '<div>سلام</div>' },
        { path: 'js/scene.js', content: 'Studio.scene({ render() {} })' },
      ],
      store.blobs,
    );
    return { folder, store, tree };
  }

  it('points a scene at a tree as one undoable entry and keeps every revision', async () => {
    const { store, tree } = await withScene();
    const first = store.setSceneCode({
      sceneId: 's1',
      treeHash: tree.treeHash,
      author: 'ai',
      label: 'Wrote the scene',
      generationId: 'g1',
    });
    expect(first.document.scenario.scenes[0]?.code.treeHash).toBe(tree.treeHash);
    const second = await treeFromFiles([{ path: 'index.html', content: 'v2' }], store.blobs);
    store.setSceneCode({
      sceneId: 's1',
      treeHash: second.treeHash,
      author: 'user',
      label: 'Edited',
    });
    expect(store.codeRevisions('s1').map((r) => [r.treeHash, r.author, r.generationId])).toEqual([
      [second.treeHash, 'user', null],
      [tree.treeHash, 'ai', 'g1'],
    ]);
    expect(store.codeRevisions('s1')[0]?.parentId).toBe(store.codeRevisions('s1')[1]?.id);
    expect(store.undo()?.document.scenario.scenes[0]?.code.treeHash).toBe(tree.treeHash);
    expect(() =>
      store.setSceneCode({ sceneId: 'gone', treeHash: tree.treeHash, author: 'ai', label: 'x' }),
    ).toThrow(/not in the video/);
  });

  it('mirrors the current code into scenes/<id>, and clears it when the scene has none', async () => {
    const { folder, store, tree } = await withScene();
    store.setSceneCode({ sceneId: 's1', treeHash: tree.treeHash, author: 'ai', label: 'x' });
    await store.mirrorScene('s1');
    const dir = join(folder, 'scenes', 's1');
    expect(await readFile(join(dir, 'index.html'), 'utf8')).toBe('<div>سلام</div>');
    expect(await readFile(join(dir, 'js', 'scene.js'), 'utf8')).toContain('Studio.scene');
    store.undo();
    await store.mirrorScene('s1');
    await expect(readdir(dir)).rejects.toThrow();
  });
});

describe('narration follows its scene', () => {
  it('moves a later scene narration when an earlier scene grows, in the same undo step', async () => {
    const { folder } = await newVideo();
    const store = await open(folder);
    const voice = {
      id: 'nv-s2-abc',
      trackId: 'track-voice',
      start: 5 * 705_600_000,
      duration: 705_600_000,
      source: { type: 'media' as const, hash: 'a'.repeat(64), in: 0, out: 705_600_000 },
      transitionIn: null,
      gain: 1,
      fadeIn: 0,
      fadeOut: 0,
    };
    store.apply({
      baseSeq: 1,
      ops: [addScene('s1'), addScene('s2'), { op: 'clip.add', clip: voice }],
      label: 'Setup',
    });
    const grown = store.apply({
      baseSeq: 2,
      ops: [{ op: 'scene.update', sceneId: 's1', patch: { targetDuration: 8 * 705_600_000 } }],
      label: 'Longer scene 1',
    });
    expect(grown.document.timeline.clips[0]?.start).toBe(8 * 705_600_000);
    const undone = store.undo();
    expect(undone?.document.timeline.clips[0]?.start).toBe(5 * 705_600_000);
  });
});
