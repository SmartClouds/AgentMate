import { access, mkdir, readdir, rm } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createScene } from '../document/schema.js';
import type { StudioEvent } from '../api.js';
import { openNodeSqlite } from '../test/nodeSqlite.js';
import { useTempDirs } from '../test/tempDir.js';
import { createStudioService, type StudioHost, type StudioService } from './service.js';

const tempDir = useTempDirs();
const services: StudioService[] = [];
afterEach(async () => {
  await Promise.all(services.splice(0).map((s) => s.shutdown()));
});

interface Setup {
  base: string;
  service: StudioService;
  host: StudioHost;
  events: StudioEvent[];
  projectFolder: string;
}

let clock = 1_700_000_000_000;

async function setup(over: Partial<StudioHost> = {}, base?: string): Promise<Setup> {
  const root = base ?? (await tempDir());
  const projectFolder = join(root, 'code', 'shop-app');
  await mkdir(projectFolder, { recursive: true });
  const events: StudioEvent[] = [];
  const host: StudioHost = {
    dataDir: join(root, 'userData', 'studio'),
    defaultLibraryRoot: join(root, 'Videos', 'AgentMate Studio'),
    defaultCacheDir: join(root, 'userData', 'studio-cache'),
    appDir: join(root, 'app'),
    appId: 'AgentMate',
    openDb: openNodeSqlite,
    projects: {
      get: (id) => (id === 'p1' ? { id: 'p1', name: 'Shop App', folderPath: projectFolder } : null),
    },
    notify: (event) => events.push(event),
    now: () => clock++,
    pid: process.pid,
    hostname: 'laptop',
    ...over,
  };
  const service = createStudioService(host);
  services.push(service);
  return { base: root, service, host, events, projectFolder };
}

const newVideo = (s: StudioService, projectId: string | null = null, title = 'Launch film') =>
  s.create({ title, projectId, language: 'fa', aspect: '16:9' });

async function openSession(s: StudioService, videoId: string) {
  const result = await s.open({ videoId });
  if (result.state !== 'open') throw new Error(`expected open, got ${result.state}`);
  return result.session;
}

describe('settings and storage folders', () => {
  it('uses the Studio library under Videos and a local cache by default', async () => {
    const { service, host } = await setup();
    expect(await service.settings()).toEqual({
      defaultRoot: host.defaultLibraryRoot,
      defaultRootIsCustom: false,
      standaloneRoot: join(host.defaultLibraryRoot, 'Standalone'),
      cacheDir: host.defaultCacheDir,
      cacheCapGb: 20,
      autoResumeRenders: true,
      hwEncode: true,
    });
  });

  it('gives each project its own folder in the library until the user picks another', async () => {
    const { service, host } = await setup();
    const storage = await service.projectStorage({ projectId: 'p1' });
    expect(storage).toMatchObject({
      root: join(host.defaultLibraryRoot, 'Projects', 'Shop-App'),
      isCustom: false,
      check: { ok: true },
    });
  });

  it('refuses a project folder inside the project source, and keeps the old one', async () => {
    const { service, projectFolder } = await setup();
    await expect(
      service.setProjectRoot({ projectId: 'p1', path: join(projectFolder, 'videos') }),
    ).rejects.toThrow(/inside the project/);
    expect((await service.projectStorage({ projectId: 'p1' })).isCustom).toBe(false);
  });

  it('saves a project folder the user picked, and resets it on request', async () => {
    const { service, base } = await setup();
    const chosen = join(base, 'Media', 'Shop videos');
    const saved = await service.setProjectRoot({ projectId: 'p1', path: chosen });
    expect(saved).toMatchObject({ root: chosen, isCustom: true });
    const reset = await service.setProjectRoot({ projectId: 'p1', path: null });
    expect(reset.isCustom).toBe(false);
  });

  it('refuses a folder for a project it does not know', async () => {
    const { service } = await setup();
    await expect(service.projectStorage({ projectId: 'ghost' })).rejects.toThrow(/project/);
  });

  it('checks a folder the user is typing, against the project when there is one', async () => {
    const { service, projectFolder, base } = await setup();
    const inside = await service.checkRoot({ path: join(projectFolder, 'v'), projectId: 'p1' });
    expect(inside.ok).toBe(false);
    const outside = await service.checkRoot({ path: join(base, 'elsewhere'), projectId: null });
    expect(outside.ok).toBe(true);
  });

  it('changes the library folder only to one that passes the checks', async () => {
    const { service, host, base } = await setup();
    await expect(
      service.updateSettings({ defaultRoot: join(host.appDir as string, 'x') }),
    ).rejects.toThrow(/AgentMate's own folder/);
    const next = await service.updateSettings({ defaultRoot: join(base, 'Lib'), cacheCapGb: 50 });
    expect(next).toMatchObject({
      defaultRoot: join(base, 'Lib'),
      defaultRootIsCustom: true,
      cacheCapGb: 50,
    });
  });

  it('drops the folders of projects that were removed from AgentMate', async () => {
    const { service, base } = await setup();
    await service.setProjectRoot({ projectId: 'p1', path: join(base, 'Media') });
    await service.pruneProjects(new Set());
    expect((await service.projectStorage({ projectId: 'p1' })).isCustom).toBe(false);
  });
});

describe('creating and listing videos', () => {
  it('puts a standalone video in the library and a project video in the project folder', async () => {
    const { service, host } = await setup();
    const standalone = await newVideo(service);
    const forProject = await newVideo(service, 'p1', 'Shop teaser');
    expect(standalone.folder.startsWith(join(host.defaultLibraryRoot, 'Standalone'))).toBe(true);
    expect(
      forProject.folder.startsWith(join(host.defaultLibraryRoot, 'Projects', 'Shop-App')),
    ).toBe(true);
    expect(forProject.linkedProjectId).toBe('p1');
  });

  it('lists videos newest first, filtered by project or standalone', async () => {
    const { service } = await setup();
    const a = await newVideo(service, null, 'A');
    const b = await newVideo(service, 'p1', 'B');
    expect((await service.list()).map((v) => v.id)).toEqual([b.id, a.id]);
    expect((await service.list({ projectId: 'p1' })).map((v) => v.id)).toEqual([b.id]);
    expect((await service.list({ projectId: null })).map((v) => v.id)).toEqual([a.id]);
  });

  it('marks a video whose folder disappeared', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await rm(video.folder, { recursive: true });
    expect((await service.list())[0]).toMatchObject({ id: video.id, missing: true });
    expect(await service.open({ videoId: video.id })).toMatchObject({ state: 'missing' });
  });

  it('refuses to create a project video when the project folder setting points inside the project', async () => {
    const { service, projectFolder, host } = await setup();
    const { writeFile } = await import('node:fs/promises');
    await mkdir(host.dataDir, { recursive: true });
    await writeFile(
      join(host.dataDir, 'settings.json'),
      JSON.stringify({
        version: 1,
        defaultRoot: null,
        cacheDir: null,
        cacheCapGb: 20,
        autoResumeRenders: true,
        hwEncode: true,
        projectRoots: { p1: join(projectFolder, 'videos') },
      }),
    );
    await expect(newVideo(service, 'p1')).rejects.toThrow(/inside the project/);
  });

  it('tells the UI the library changed', async () => {
    const { service, events } = await setup();
    await newVideo(service);
    expect(events).toContainEqual({ type: 'library-changed' });
  });
});

describe('editing a video', () => {
  it('opens, edits, undoes and keeps history', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    const session = await openSession(service, video.id);
    expect(session.status).toMatchObject({ seq: 1, canUndo: false });

    const applied = await service.apply({
      videoId: video.id,
      baseSeq: 1,
      ops: [{ op: 'scene.add', scene: createScene({ id: 's1', title: 'Hook' }), index: 0 }],
      label: 'Added a scene',
    });
    expect(applied).toMatchObject({
      ok: true,
      seq: 2,
      status: { canUndo: true, undoLabel: 'Added a scene' },
    });

    const undone = await service.undo({ videoId: video.id });
    expect(undone?.document.scenario.scenes).toEqual([]);
    const redone = await service.redo({ videoId: video.id });
    expect(redone?.document.scenario.scenes).toHaveLength(1);

    const history = await service.history({ videoId: video.id, limit: 10 });
    expect(history.map((h) => h.label)).toEqual([
      'Redo: Added a scene',
      'Undo: Added a scene',
      'Added a scene',
      'Video created',
    ]);
    expect((await service.version({ videoId: video.id, seq: 1 })).scenario.scenes).toEqual([]);
    const restored = await service.restore({ videoId: video.id, seq: 1 });
    expect(restored.document.scenario.scenes).toEqual([]);
  });

  it('answers a stale edit with where the video stands now instead of failing', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    const op = { op: 'doc.set' as const, field: 'title' as const, value: 'x' };
    await service.apply({ videoId: video.id, baseSeq: 1, ops: [op], label: 'one' });
    const stale = await service.apply({ videoId: video.id, baseSeq: 1, ops: [op], label: 'two' });
    expect(stale).toMatchObject({ ok: false, reason: 'stale', seq: 2 });
  });

  it('opens an already-open video again without a second writer', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    expect((await service.open({ videoId: video.id })).state).toBe('open');
  });

  it('refuses edits to a video that is not open', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await expect(service.undo({ videoId: video.id })).rejects.toThrow(/not open/);
  });

  it('reports the edits it saved', async () => {
    const { service, events } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    await service.apply({
      videoId: video.id,
      baseSeq: 1,
      ops: [{ op: 'doc.set', field: 'title', value: 'New' }],
      label: 'Renamed',
    });
    expect(events).toContainEqual({ type: 'video-changed', videoId: video.id, seq: 2 });
  });
});

describe('two copies of AgentMate', () => {
  it('lets only one open a video, and says which one has it', async () => {
    const first = await setup({ appId: 'AgentMate' });
    const video = await newVideo(first.service);
    await openSession(first.service, video.id);

    const second = await setup({ appId: 'AgentMate Dev', pid: 999_999_1 }, await tempDir());
    const added = await second.service.addExisting({ folder: video.folder });
    const result = await second.service.open({ videoId: added.id });
    expect(result).toMatchObject({
      state: 'locked',
      stale: false,
      holder: { appId: 'AgentMate', host: 'laptop' },
    });
    await expect(second.service.takeOver({ videoId: added.id })).resolves.toMatchObject({
      state: 'locked',
    });

    await first.service.close({ videoId: video.id });
    expect((await second.service.open({ videoId: added.id })).state).toBe('open');
  });

  it('takes over a video whose holder stopped answering', async () => {
    const first = await setup({ appId: 'AgentMate', hostname: 'desktop' });
    const video = await newVideo(first.service);
    await openSession(first.service, video.id);
    first.service.abandonForTest(video.id);

    const later = clock + 120_000;
    const second = await setup({ appId: 'AgentMate Dev', now: () => later }, await tempDir());
    const added = await second.service.addExisting({ folder: video.folder });
    expect(await second.service.open({ videoId: added.id })).toMatchObject({
      state: 'locked',
      stale: true,
    });
    expect((await second.service.takeOver({ videoId: added.id })).state).toBe('open');
  });
});

describe('library upkeep', () => {
  it('adds an existing video folder, and finds a moved one again', async () => {
    const { service, base } = await setup();
    const video = await newVideo(service);
    await service.removeFromLibrary({ videoId: video.id });
    expect(await service.list()).toEqual([]);
    await access(video.folder);

    const added = await service.addExisting({ folder: video.folder });
    expect(added.id).toBe(video.id);

    const moved = join(base, 'moved-here');
    const { rename } = await import('node:fs/promises');
    await rename(video.folder, moved);
    expect((await service.list())[0]?.missing).toBe(true);
    const located = await service.locate({ videoId: video.id, folder: moved });
    expect(located).toMatchObject({ folder: moved, missing: false });
  });

  it('refuses to locate a different video', async () => {
    const { service } = await setup();
    const a = await newVideo(service, null, 'A');
    const b = await newVideo(service, null, 'B');
    await expect(service.locate({ videoId: a.id, folder: b.folder })).rejects.toThrow(
      /different video/,
    );
  });

  it('moves a video to another folder and keeps the old copy for the user to delete', async () => {
    const { service, base } = await setup();
    const video = await newVideo(service);
    const session = await openSession(service, video.id);
    await service.apply({
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [{ op: 'doc.set', field: 'title', value: 'Moved film' }],
      label: 'Renamed',
    });
    const target = join(base, 'Archive');
    const result = await service.move({ videoId: video.id, toRoot: target });
    expect(result.oldFolder).toBe(video.folder);
    expect(result.video.folder.startsWith(target)).toBe(true);
    expect(await readdir(result.video.folder)).not.toContain('.studio.lock');
    const reopened = await openSession(service, video.id);
    expect(reopened.document.title).toBe('Moved film');
    expect(reopened.status.seq).toBe(2);
  });

  it('refuses to move a video into a project source folder', async () => {
    const { service, projectFolder } = await setup();
    const video = await newVideo(service, 'p1');
    await expect(
      service.move({ videoId: video.id, toRoot: join(projectFolder, 'v') }),
    ).rejects.toThrow(/inside the project/);
  });

  it('closes every open video on shutdown, so their locks are released', async () => {
    const { service } = await setup();
    const video = await newVideo(service);
    await openSession(service, video.id);
    await service.shutdown();
    expect(await readdir(video.folder)).not.toContain('.studio.lock');
  });
});
