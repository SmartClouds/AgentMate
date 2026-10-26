import { readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScene } from '../../document/schema.js';
import { fakeFrameHost } from '../../test/fakeFrames.js';
import { fakeTools } from '../../test/ffmpegTools.js';
import { openNodeSqlite } from '../../test/nodeSqlite.js';
import { useTempDirs } from '../../test/tempDir.js';
import { createStudioService, type StudioService } from '../service.js';

/**
 * The history browser's service side (E39): comparing any two versions, reading a code tree's
 * files, and starting a new video from a version with only the files it uses.
 */

const tempDir = useTempDirs();
const services: StudioService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

const probe = (name: string) => ({
  probe: {
    format: { duration: '2.0', format_name: 'wav' },
    streams: [{ codec_type: 'audio', disposition: { attached_pic: 0 } }],
    name,
  },
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
  });
  services.push(service);
  const video = await service.create({
    title: 'Launch',
    projectId: null,
    language: 'fa',
    aspect: '16:9',
  });
  const opened = await service.open({ videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  // Two files imported; only one ends up on the timeline.
  const used = join(root, 'used.wav');
  const unused = join(root, 'unused.wav');
  await writeFile(used, JSON.stringify(probe('used')));
  await writeFile(unused, JSON.stringify(probe('unused')));
  const imported = await service.importMedia({ videoId: video.id, paths: [used, unused] });
  const usedHash = imported.imported.find((m) => m.name === 'used.wav')?.hash as string;
  const one = await service.apply({
    videoId: video.id,
    baseSeq: opened.session.status.seq,
    ops: [
      {
        op: 'scene.add',
        index: 0,
        scene: createScene({ id: 'a', title: 'Hello', narration: 'سلام' }),
      },
    ],
    label: 'Scene',
  });
  const coded = await service.saveSceneFiles({
    videoId: video.id,
    sceneId: 'a',
    files: [{ path: 'index.html', content: '<p>first</p>' }],
  });
  const two = await service.apply({
    videoId: video.id,
    baseSeq: coded.status.seq,
    ops: [
      { op: 'doc.set', field: 'title', value: 'Launch day' },
      { op: 'scene.update', sceneId: 'a', patch: { narration: 'سلام دنیا' } },
      {
        op: 'clip.add',
        clip: {
          id: 'm1',
          trackId: 'track-music',
          start: 0,
          duration: 705_600_000,
          source: { type: 'media', hash: usedHash, in: 0, out: 705_600_000 },
          transitionIn: null,
          gain: 1,
          fadeIn: 0,
          fadeOut: 0,
        },
      },
    ],
    label: 'More',
  });
  return {
    root,
    service,
    video,
    one: one.seq,
    coded: coded.status.seq,
    two: two.seq,
    usedHash,
    imported,
  };
}

describe('the history browser, through the service', () => {
  it('compares any two versions, naming the clip by its file', async () => {
    const { service, video, one, two } = await setup();
    const changes = await service.compareVersions({ videoId: video.id, from: one, to: two });
    expect(changes.map((c) => c.kind)).toEqual(['title', 'scene-changed', 'clip-added']);
    expect(changes.find((c) => c.kind === 'clip-added')).toMatchObject({ label: 'used.wav' });
    expect(await service.compareVersions({ videoId: video.id, from: two, to: two })).toEqual([]);
    await expect(service.compareVersions({ videoId: video.id, from: 1, to: 999 })).rejects.toThrow(
      'There is no version 999 of this video.',
    );
  });

  it('reads the text files of a code tree for a code comparison', async () => {
    const { service, video } = await setup();
    const opened = await service.open({ videoId: video.id });
    if (opened.state !== 'open') throw new Error('not open');
    const tree = opened.session.document.scenario.scenes[0]?.code.treeHash as string;
    expect(await service.treeFiles({ videoId: video.id, treeHash: tree })).toEqual([
      { path: 'index.html', text: '<p>first</p>' },
    ]);
  });

  it('starts a new video from a version, with its document and only the files it uses', async () => {
    const { service, video, two, usedHash } = await setup();
    const branch = await service.branchVideo({ videoId: video.id, seq: two });
    expect(branch).toMatchObject({ title: 'Launch day (from version 4)', linkedProjectId: null });
    expect(branch.id).not.toBe(video.id);
    const opened = await service.open({ videoId: branch.id });
    if (opened.state !== 'open') throw new Error('not open');
    const doc = opened.session.document;
    expect(doc.id).toBe(branch.id);
    expect(doc.scenario.scenes[0]?.narration).toBe('سلام دنیا');
    expect(doc.scenario.scenes[0]?.code.treeHash).toBeTruthy();
    expect((await service.media({ videoId: branch.id })).map((m) => m.hash)).toEqual([usedHash]);
    // The code tree came along, so the scene still has its files.
    const code = await service.sceneCode({ videoId: branch.id, sceneId: 'a' });
    expect(code.files.map((f) => [f.path, f.text])).toEqual([['index.html', '<p>first</p>']]);
    // The blob store holds the used file, the tree and its one file, not the unused import.
    const blobs = join(branch.folder, 'blobs');
    const count = (
      await Promise.all((await readdir(blobs)).map((d) => readdir(join(blobs, d))))
    ).flat().length;
    expect(count).toBe(3);
    expect((await service.list()).length).toBe(2);
  });
});

describe("Studio's part of the app backup", () => {
  it('carries the settings and recipes to another copy, and refuses a damaged section', async () => {
    const { service } = await setup();
    await service.updateSettings({ cacheCapGb: 42 });
    await service.saveRecipe({
      name: 'Explainer',
      brief: 'Explain it',
      styleId: null,
      language: 'en',
      aspect: '16:9',
      targetSeconds: 30,
      scenario: { cliId: null },
    });
    const backup = await service.backupData();
    expect(service.checkBackup(backup)).toBeNull();

    const other = createStudioService({
      dataDir: join(await tempDir(), 'studio'),
      defaultLibraryRoot: join(await tempDir(), 'Videos'),
      defaultCacheDir: join(await tempDir(), 'cache'),
      appDir: null,
      appId: 'AgentMate',
      openDb: openNodeSqlite,
      projects: { get: () => null },
      notify: () => undefined,
    });
    services.push(other);
    await other.restoreBackup(backup);
    expect((await other.settings()).cacheCapGb).toBe(42);
    expect((await other.recipes()).map((r) => r.name)).toEqual(['Explainer']);
    expect(other.checkBackup({ settings: { nope: true } })).toBe(
      "The backup's Studio settings could not be read.",
    );
    expect(other.checkBackup({ recipes: 'nope' })).toBe(
      "The backup's Studio recipes could not be read.",
    );
    expect(other.checkBackup({})).toBeNull();
  });
});
