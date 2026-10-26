import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import type { ImportResult, MediaView, OpenVideoResult, VideoSummary } from '@runova/studio';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { IPC } from '../../shared/ipcChannels';
import { electronState, queueDialog, setElectronPath } from '../../test/main/electronMock';
import {
  expectChannelsCovered,
  fakeWebContents,
  invoke,
  invokeFrom,
  loadIpc,
  useTempUserData,
} from '../../test/main/ipcHarness';

/**
 * Studio's media channels (E35) against the real service and desktop host: import through the file
 * dialog or by dropping files, and list a video's media. ffmpeg is absent here, so files are
 * skipped with the way to install it; importing itself is covered in the package, with a stand-in
 * ffmpeg and the real one.
 */

vi.mock('../devSetup/runtime', () => ({
  getDevSetupService: () => ({ detect: vi.fn(async () => ({ state: 'absent' })) }),
}));
vi.mock('../studio/capture/offscreenSource', () => ({
  createOffscreenSource: vi.fn(),
  sceneWindowsMemoryBytes: () => 0,
}));

const userData = useTempUserData();
expectChannelsCovered(IPC.studioMedia);

const allowed = { value: true };

beforeEach(async () => {
  allowed.value = true;
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

async function openVideo(): Promise<string> {
  const video = await invoke<VideoSummary>(IPC.studio.create, {
    title: 'Launch',
    projectId: null,
    language: 'en',
    aspect: '16:9',
  });
  const opened = await invoke<OpenVideoResult>(IPC.studio.open, { videoId: video.id });
  if (opened.state !== 'open') throw new Error('not open');
  return video.id;
}

describe('media channels', () => {
  it('imports what the user picks, and nothing when they cancel', async () => {
    const videoId = await openVideo();
    const clip = join(userData.dir, 'beach.mp4');
    writeFileSync(clip, 'not really a video');
    queueDialog('showOpenDialog', { canceled: true, filePaths: [] });
    expect(await invoke(IPC.studioMedia.pickAndImport, { videoId })).toBeNull();
    queueDialog('showOpenDialog', { canceled: false, filePaths: [clip] });
    const result = await invoke<ImportResult>(IPC.studioMedia.pickAndImport, { videoId });
    expect(result.imported).toEqual([]);
    expect(result.skipped).toEqual([
      { path: clip, reason: expect.stringMatching(/^Importing needs ffmpeg/) },
    ]);
    const dialog = electronState.dialogCalls.at(-1);
    expect(JSON.stringify(dialog?.args)).toContain('multiSelections');
    expect(JSON.stringify(dialog?.args)).toContain('"mp4"');
  });

  it('imports dropped files, and lists the video media', async () => {
    const videoId = await openVideo();
    mkdirSync(join(userData.dir, 'drop'), { recursive: true });
    const notes = join(userData.dir, 'drop', 'notes.txt');
    writeFileSync(notes, 'x');
    const result = await invoke<ImportResult>(IPC.studioMedia.importFiles, {
      videoId,
      paths: [notes],
    });
    expect(result.skipped).toEqual([
      { path: notes, reason: 'Studio does not take this kind of file.' },
    ]);
    expect(await invoke<MediaView[]>(IPC.studioMedia.list, { videoId })).toEqual([]);
    await expect(invoke(IPC.studioMedia.importFiles, { videoId, paths: [] })).rejects.toThrow(
      'That Studio request is not valid (paths)',
    );
  });

  it('answers only the main window', async () => {
    allowed.value = false;
    await expect(
      invokeFrom(fakeWebContents(), IPC.studioMedia.list, { videoId: 'v1' }),
    ).rejects.toThrow('Studio only answers the main window.');
  });
});
