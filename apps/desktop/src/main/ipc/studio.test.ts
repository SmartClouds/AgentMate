import { existsSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import type {
  ApplyResult,
  EditResponse,
  HistoryEntryView,
  MoveResult,
  OpenVideoResult,
  ProjectStorageView,
  RootCheckView,
  StudioSettingsView,
  VideoSummary,
} from '@agentmat/studio';
import { createScene, type StudioDocument } from '@agentmat/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import {
  electronState,
  FakeBrowserWindow,
  queueDialog,
  setElectronPath,
} from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Studio's channels (E31), run against the real service over the test SQLite: what each one
 * accepts, what it refuses before the service sees it, and that it only answers the main window.
 */

const userData = useTempUserData();
// onEvent is main to renderer; it is checked through what the windows were sent.
expectChannelsCovered(IPC.studio, [IPC.studio.onEvent]);

let projectFolder = '';
let videosDir = '';
const allowed = { value: true };

beforeEach(async () => {
  projectFolder = join(userData.dir, 'code', 'shop');
  videosDir = join(userData.dir, 'home', 'Videos');
  mkdirSync(projectFolder, { recursive: true });
  setElectronPath('videos', videosDir);
  userData.writeData('projects.json', [
    { id: 'p1', name: 'Shop', folderPath: projectFolder, createdAt: 1, updatedAt: 1 },
  ]);
  allowed.value = true;
  await loadIpc(
    () => import('./studio'),
    (m) => m.registerStudioHandlers({ guard: () => allowed.value }),
  );
});

afterEach(async () => {
  const { shutdownStudio } = await import('../studio');
  await shutdownStudio();
});

const create = (projectId: string | null = null) =>
  invoke<VideoSummary>(IPC.studio.create, {
    title: 'Launch film',
    projectId,
    language: 'fa',
    aspect: '9:16',
  });

async function openVideo(videoId: string) {
  const result = await invoke<OpenVideoResult>(IPC.studio.open, { videoId });
  if (result.state !== 'open') throw new Error(`expected open, got ${result.state}`);
  return result.session;
}

describe('settings and folders', () => {
  it('reads and changes Studio settings, with the library under Videos', async () => {
    const settings = await invoke<StudioSettingsView>(IPC.studio.settings);
    expect(settings.defaultRoot).toBe(join(videosDir, 'AgentMate Studio'));
    const changed = await invoke<StudioSettingsView>(IPC.studio.updateSettings, { cacheCapGb: 40 });
    expect(changed.cacheCapGb).toBe(40);
  });

  it('refuses a settings change it does not recognise', async () => {
    await expect(invoke(IPC.studio.updateSettings, { theme: 'dark' })).rejects.toThrow(/not valid/);
  });

  it('shows and changes where a project keeps its videos', async () => {
    const storage = await invoke<ProjectStorageView>(IPC.studio.projectStorage, {
      projectId: 'p1',
    });
    expect(storage.root).toBe(join(videosDir, 'AgentMate Studio', 'Projects', 'Shop'));
    const elsewhere = join(userData.dir, 'media');
    const changed = await invoke<ProjectStorageView>(IPC.studio.setProjectRoot, {
      projectId: 'p1',
      path: elsewhere,
    });
    expect(changed).toMatchObject({ root: elsewhere, isCustom: true });
  });

  it('refuses a folder inside the project source', async () => {
    await expect(
      invoke(IPC.studio.setProjectRoot, { projectId: 'p1', path: join(projectFolder, 'videos') }),
    ).rejects.toThrow(/inside the project/);
    const check = await invoke<RootCheckView>(IPC.studio.checkRoot, {
      path: join(projectFolder, 'videos'),
      projectId: 'p1',
    });
    expect(check.ok).toBe(false);
  });

  it('opens the system folder picker and returns the folder, or null when cancelled', async () => {
    queueDialog('showOpenDialog', { canceled: false, filePaths: ['D:\\Media'] });
    expect(await invoke(IPC.studio.pickFolder, { defaultPath: videosDir })).toBe('D:\\Media');
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke(IPC.studio.pickFolder, {})).toBeNull();
  });
});

describe('videos', () => {
  it('creates, lists, opens and edits a video, and keeps its history', async () => {
    const video = await create('p1');
    expect(
      (await invoke<VideoSummary[]>(IPC.studio.list, { projectId: 'p1' })).map((v) => v.id),
    ).toEqual([video.id]);
    const session = await openVideo(video.id);
    expect(session.document.renderSettings.aspect).toBe('9:16');

    const applied = await invoke<ApplyResult>(IPC.studio.apply, {
      videoId: video.id,
      baseSeq: session.status.seq,
      ops: [{ op: 'scene.add', scene: createScene({ id: 's1', title: 'Hook' }), index: 0 }],
      label: 'Added a scene',
    });
    expect(applied.ok).toBe(true);
    const undone = await invoke<EditResponse>(IPC.studio.undo, { videoId: video.id });
    expect(undone.document.scenario.scenes).toEqual([]);
    const redone = await invoke<EditResponse>(IPC.studio.redo, { videoId: video.id });
    expect(redone.document.scenario.scenes).toHaveLength(1);

    const history = await invoke<HistoryEntryView[]>(IPC.studio.history, {
      videoId: video.id,
      limit: 10,
    });
    expect(history[0]?.label).toBe('Redo: Added a scene');
    const first = await invoke<StudioDocument>(IPC.studio.version, { videoId: video.id, seq: 1 });
    expect(first.scenario.scenes).toEqual([]);
    const restored = await invoke<EditResponse>(IPC.studio.restore, { videoId: video.id, seq: 1 });
    expect(restored.document.scenario.scenes).toEqual([]);
    await invoke(IPC.studio.close, { videoId: video.id });
  });

  it('refuses an edit op it does not know before the service sees it', async () => {
    const video = await create();
    await openVideo(video.id);
    await expect(
      invoke(IPC.studio.apply, {
        videoId: video.id,
        baseSeq: 1,
        ops: [{ op: 'scene.explode' }],
        label: 'x',
      }),
    ).rejects.toThrow(/not valid/);
  });

  it('refuses a language Studio does not offer', async () => {
    await expect(
      invoke(IPC.studio.create, { title: 'x', projectId: null, language: 'zh', aspect: '16:9' }),
    ).rejects.toThrow(/not valid/);
  });

  it('takes over only a lock that went quiet', async () => {
    const video = await create();
    await openVideo(video.id);
    expect((await invoke<OpenVideoResult>(IPC.studio.takeOver, { videoId: video.id })).state).toBe(
      'open',
    );
  });

  it('adds, locates and removes videos from the library without deleting files', async () => {
    const video = await create();
    await invoke(IPC.studio.removeFromLibrary, { videoId: video.id });
    expect(await invoke<VideoSummary[]>(IPC.studio.list)).toEqual([]);
    expect(existsSync(video.folder)).toBe(true);
    const added = await invoke<VideoSummary>(IPC.studio.addExisting, { folder: video.folder });
    expect(added.id).toBe(video.id);
    const located = await invoke<VideoSummary>(IPC.studio.locate, {
      videoId: video.id,
      folder: video.folder,
    });
    expect(located.missing).toBe(false);
  });

  it('moves a video and then trashes the old copy, but trashes nothing else', async () => {
    const video = await create();
    const moved = await invoke<MoveResult>(IPC.studio.move, {
      videoId: video.id,
      toRoot: join(userData.dir, 'archive'),
    });
    expect(moved.oldFolder).toBe(video.folder);
    await expect(invoke(IPC.studio.trashOldFolder, { folder: projectFolder })).rejects.toThrow(
      /only remove the old copy/,
    );
    const { shell } = await import('electron');
    const trash = vi.spyOn(shell, 'trashItem');
    await invoke(IPC.studio.trashOldFolder, { folder: moved.oldFolder });
    expect(trash).toHaveBeenCalledWith(moved.oldFolder);
    await expect(invoke(IPC.studio.trashOldFolder, { folder: moved.oldFolder })).rejects.toThrow(
      /only remove the old copy/,
    );
  });

  it("opens a video's folder in the file manager", async () => {
    const video = await create();
    await invoke(IPC.studio.revealVideo, { videoId: video.id });
    expect(electronState.openedPaths).toContain(video.folder);
  });

  it('tells every window when the library changes', async () => {
    const win = new FakeBrowserWindow();
    await create();
    expect(win.webContents.sentOn(IPC.studio.onEvent)).toContainEqual([
      { type: 'library-changed' },
    ]);
  });
});

describe('who may call', () => {
  it('answers only the main window', async () => {
    allowed.value = false;
    await expect(invokeFrom(fakeWebContents(), IPC.studio.list)).rejects.toThrow(/main window/);
  });
});
